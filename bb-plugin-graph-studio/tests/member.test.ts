// Member nodes (E5): a graph step that runs on a persistent Crew member.
//
// The expensive mistake this kind can make is not a crash — it is a member
// node that quietly becomes a fresh thread, or a persistent thread that gets
// told "the run is over, stop". Every rule here is therefore tested both ways.
import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import {
  END_NODE,
  START_NODE,
  doesWork,
  emptyRunState,
  graphSchema,
  memberNodes,
  nodeExecution,
  validateGraph,
  type Graph,
} from "../lib/graph";
import { compileGraph, type RuntimeHost } from "../lib/runtime";
import { interruptibleWorkers, orphanedWorkers } from "../lib/orphans";
import type { NodeRunRow } from "../lib/store";
import {
  createCrewClient,
  memberCorrelationId,
  memberProblems,
  type CallRpc,
} from "../lib/crew";
import {
  OWNER_CHECK_PLACEHOLDER_CREW,
  TEMPLATES,
  ownerCheckLoopFor,
  templateById,
} from "../lib/templates";

const memberGraph = (member: string, extra: Record<string, unknown> = {}): Graph =>
  graphSchema.parse({
    id: "m",
    name: "M",
    nodes: [{ id: "step", label: "Step", kind: "member", member, prompt: "Do {{input}}", ...extra }],
    edges: [
      { from: START_NODE, to: "step" },
      { from: "step", to: END_NODE },
    ],
  });

const errors = (graph: Graph, resolve?: (id: string) => Graph | null) =>
  validateGraph(graph, resolve).filter((problem) => problem.level === "error");

describe("member node schema", () => {
  it("accepts kind member with a member address", () => {
    const graph = memberGraph("dev-check@first-project");
    expect(graph.nodes[0]!.kind).toBe("member");
    expect(graph.nodes[0]!.member).toBe("dev-check@first-project");
    expect(errors(graph)).toEqual([]);
  });

  it("defaults member to empty for every other kind", () => {
    const graph = graphSchema.parse({ id: "a", name: "A", nodes: [{ id: "x", label: "X" }], edges: [] });
    expect(graph.nodes[0]!.member).toBe("");
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      graphSchema.parse({ id: "a", name: "A", nodes: [{ id: "x", label: "X", kind: "seat" }], edges: [] }),
    ).toThrow();
  });

  it("refuses a member node without a member", () => {
    const found = errors(memberGraph(""));
    expect(found.map((problem) => problem.message)).toEqual([
      '"Step" is a Crew member node but names no member; write "member@crew".',
    ]);
  });

  it("refuses an address that is not member@crew", () => {
    for (const bad of ["dev-check", "dev check@crew", "@crew", "a@b@c"]) {
      const found = errors(memberGraph(bad));
      expect(found, bad).toHaveLength(1);
      expect(found[0]!.message).toContain("is not a member address");
    }
  });

  it("warns about a member address on a node of another kind", () => {
    const graph = graphSchema.parse({
      id: "a",
      name: "A",
      nodes: [{ id: "x", label: "X", prompt: "p", member: "dev@crew" }],
      edges: [{ from: START_NODE, to: "x" }, { from: "x", to: END_NODE }],
    });
    expect(validateGraph(graph).map((problem) => problem.message)).toContain(
      '"X" is a Agent node; the member "dev@crew" goes unused.',
    );
  });

  it("counts as a working node: prompt, fields and failure routing apply", () => {
    const graph = memberGraph("dev@crew", {
      prompt: "",
      onError: "route",
      fields: [{ name: "verdict", type: "enum", options: ["pass", "fail"] }],
    });
    const messages = validateGraph(graph).map((problem) => problem.message);
    expect(messages).toContain('"Step" has an empty prompt.');
    // Declared fields are used on a member node, unlike on a note.
    expect(messages.some((message) => message.includes("declared fields go unused"))).toBe(false);
    // Failure routing is honoured, not "has no effect".
    expect(messages.some((message) => message.includes("the setting has no effect"))).toBe(false);
    expect(doesWork(graph.nodes[0]!)).toBe(true);
  });

  it("does not count a note as a working node", () => {
    const note = graphSchema.parse({ id: "a", name: "A", nodes: [{ id: "x", label: "X", kind: "note" }], edges: [] });
    expect(doesWork(note.nodes[0]!)).toBe(false);
  });

  it("cannot be the target of a fan-out", () => {
    const graph = graphSchema.parse({
      id: "f",
      name: "F",
      nodes: [
        { id: "plan", label: "Plan", prompt: "p", fields: [{ name: "items", type: "list" }] },
        { id: "step", label: "Step", kind: "member", member: "dev@crew", prompt: "{{item}}" },
      ],
      edges: [
        { from: START_NODE, to: "plan" },
        { from: "plan", to: "step", fanOutOver: "plan.items" },
        { from: "step", to: END_NODE },
      ],
    });
    expect(errors(graph).map((problem) => problem.message)).toContain(
      '"Step" is a Crew member node and cannot be the target of a fan-out.',
    );
  });
});

describe("nodeExecution for member nodes", () => {
  it("is null for a member node even with a provider and model on it", () => {
    const graph = memberGraph("dev@crew", { providerId: "pi", model: "bogus" });
    expect(nodeExecution(graph.nodes[0]!)).toBeNull();
    // Said, not silently dropped.
    expect(validateGraph(graph).map((problem) => problem.message)).toContain(
      '"Step" is a Crew member node and starts no worker; the model choice goes unused.',
    );
  });

  it("still resolves the execution of an agent node", () => {
    const agent = graphSchema.parse({
      id: "a",
      name: "A",
      nodes: [{ id: "x", label: "X", providerId: "pi", model: "bogus" }],
      edges: [],
    });
    expect(nodeExecution(agent.nodes[0]!)).toEqual({
      providerId: "pi",
      model: "bogus",
      reasoningLevel: null,
      serviceTier: null,
    });
  });
});

describe("memberNodes", () => {
  it("finds member nodes inside an embedded graph", () => {
    const child = memberGraph("dev@crew");
    const parent = graphSchema.parse({
      id: "p",
      name: "P",
      nodes: [
        { id: "a", label: "A", prompt: "p" },
        { id: "sub", label: "Sub", kind: "subgraph", graphId: "m" },
      ],
      edges: [],
    });
    expect(memberNodes(parent, (id) => (id === "m" ? child : null)).map((node) => node.id)).toEqual(["step"]);
  });

  it("finds none in a graph of agents", () => {
    const graph = graphSchema.parse({ id: "a", name: "A", nodes: [{ id: "x", label: "X" }], edges: [] });
    expect(memberNodes(graph)).toEqual([]);
  });
});

function nodeRun(nodeId: string, status: NodeRunRow["status"], childThreadId: string | null): NodeRunRow {
  return {
    id: `nr_${nodeId}`,
    runId: "run_1",
    nodeId,
    attempt: 1,
    status,
    childThreadId,
    output: null,
    error: null,
    startedAt: 0,
    endedAt: null,
    inputTokens: null,
    outputTokens: null,
  };
}

describe("member threads and the run's goodbye", () => {
  const rows = [nodeRun("owner", "running", "thr_member"), nodeRun("work", "running", "thr_worker")];

  it("never tells a member thread that the run is over", () => {
    expect(orphanedWorkers(rows, [], new Set(["owner"]))).toEqual(["thr_worker"]);
  });

  it("still tells a normal worker", () => {
    expect(orphanedWorkers(rows, [], new Set())).toEqual(["thr_member", "thr_worker"]);
  });

  it("never interrupts a member thread on stop", () => {
    expect(interruptibleWorkers(rows, new Set(["owner"]))).toEqual(["thr_worker"]);
  });

  it("still interrupts a normal worker on stop", () => {
    expect(interruptibleWorkers(rows)).toEqual(["thr_member", "thr_worker"]);
  });
});

describe("memberCorrelationId", () => {
  it("is runId:gen:nodeId:visit:attempt", () => {
    expect(memberCorrelationId({ runId: "run_abc", gen: 0, nodeId: "check", visit: 2, attempt: 1 })).toBe(
      "run_abc:0:check:2:1",
    );
  });

  it("differs between generations, visits and attempts", () => {
    const base = { runId: "r", gen: 0, nodeId: "n", visit: 1, attempt: 1 };
    const ids = new Set([
      memberCorrelationId(base),
      memberCorrelationId({ ...base, gen: 1 }),
      memberCorrelationId({ ...base, visit: 2 }),
      memberCorrelationId({ ...base, attempt: 2 }),
    ]);
    expect(ids.size).toBe(4);
  });

  it("is the same for the same key (a resume reproduces it)", () => {
    const key = { runId: "r", gen: 3, nodeId: "n", visit: 1, attempt: 2 };
    expect(memberCorrelationId({ ...key })).toBe(memberCorrelationId(key));
  });
});

/** A Crew fake that answers like the plugin's contract, parsed by the caller's schema. */
function fakeCrew(members: Record<string, string | null>, calls: Array<{ method: string; input: unknown }> = []): CallRpc {
  return (async (args: Parameters<CallRpc>[0]) => {
    calls.push({ method: args.method, input: args.input });
    const answer = (() => {
      if (args.method === "listMembers") return { contractVersion: 1, members: [] };
      if (args.method === "resolveMember") {
        const address = String(args.input.address);
        if (!(address in members)) return { contractVersion: 1, member: null, error: `No member "${address}" in this project.` };
        return {
          contractVersion: 1,
          member: { memberId: "m1", address, crew: "c", key: address.split("@")[0], lead: false, role: "", threadId: members[address], shift: 1, activity: "idle" },
          error: null,
        };
      }
      throw new Error(`unexpected ${args.method}`);
    })();
    return args.outputSchema.parse(answer);
  }) as CallRpc;
}

const missingCrew: CallRpc = (async () => {
  throw new Error('Plugin "crew" is not installed');
}) as CallRpc;

describe("memberProblems (save and start check)", () => {
  it("reports a missing Crew plugin clearly", async () => {
    const problems = await memberProblems(memberGraph("dev@crew"), () => null, createCrewClient(missingCrew), "proj_1");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('The Crew plugin ("crew") is not installed or not reachable');
  });

  it("reports a missing Crew plugin even without a project", async () => {
    const problems = await memberProblems(memberGraph("dev@crew"), () => null, createCrewClient(missingCrew), null);
    expect(problems[0]).toContain("is not installed or not reachable");
  });

  it("reports an unknown member", async () => {
    const problems = await memberProblems(memberGraph("ghost@crew"), () => null, createCrewClient(fakeCrew({})), "proj_1");
    expect(problems).toEqual([
      '"Step" names the member "ghost@crew", which Crew does not know in this project (No member "ghost@crew" in this project.)',
    ]);
  });

  it("reports a member that has no thread yet", async () => {
    const problems = await memberProblems(memberGraph("dev@crew"), () => null, createCrewClient(fakeCrew({ "dev@crew": null })), "proj_1");
    expect(problems[0]).toContain("has no thread yet; apply the crew first");
  });

  it("passes a known member with a thread", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const problems = await memberProblems(memberGraph("dev@crew"), () => null, createCrewClient(fakeCrew({ "dev@crew": "thr_dev" }, calls)), "proj_1");
    expect(problems).toEqual([]);
    expect(calls).toEqual([{ method: "resolveMember", input: { projectId: "proj_1", address: "dev@crew" } }]);
  });

  it("does not ask Crew at all for a graph without member nodes", async () => {
    const graph = graphSchema.parse({ id: "a", name: "A", nodes: [{ id: "x", label: "X" }], edges: [] });
    expect(await memberProblems(graph, () => null, createCrewClient(missingCrew), "proj_1")).toEqual([]);
  });

  it("refuses a contract version it does not know", async () => {
    const future = (async (args: Parameters<CallRpc>[0]) =>
      args.outputSchema.parse({ contractVersion: 2, members: [] })) as CallRpc;
    const problems = await memberProblems(memberGraph("dev@crew"), () => null, createCrewClient(future), null);
    expect(problems[0]).toContain("contract version 2");
  });
});

/** A runtime host that only knows member nodes; `spawn` must never be reached. */
function memberHost(answers: Record<string, string[]>) {
  const sends: Array<{ nodeId: string; visit: number; attempt: number; address: string }> = [];
  const spawned: string[] = [];
  const counters: Record<string, number> = {};
  const host: RuntimeHost = {
    async spawn({ nodeId }) {
      spawned.push(nodeId);
      return `thr_${nodeId}`;
    },
    async awaitThread() {
      return "spawned output";
    },
    async sendMessage() {},
    async loadDialog() {
      return null;
    },
    async saveDialog() {},
    async sendToMember({ nodeId, visit, attempt, address }) {
      sends.push({ nodeId, visit, attempt, address });
      return { messageId: `msg_${nodeId}_${visit}_${attempt}`, threadId: `thr_member_${nodeId}` };
    },
    async awaitMemberReply({ nodeId }) {
      const list = answers[nodeId] ?? ["ok"];
      const index = counters[nodeId] ?? 0;
      counters[nodeId] = index + 1;
      return { text: list[Math.min(index, list.length - 1)]!, threadId: `thr_member_${nodeId}` };
    },
    async onNodeStart() {
      return "node-run";
    },
    async onNodeThread() {},
    async onNodeFinish() {},
    async onStateChange() {},
    log() {},
    wait: async () => {},
  };
  return { host, sends, spawned };
}

const verdict = (value: "pass" | "fail") => `Checked.\n\n\`\`\`json\n{ "verdict": "${value}", "findings": "" }\n\`\`\``;

describe("owner-check-loop on member nodes", () => {
  it("ships as a template that validates", () => {
    const template = templateById("owner-check-loop");
    expect(template).toBeTruthy();
    expect(errors(template!)).toEqual([]);
    expect(TEMPLATES.filter((graph) => graph.id === "owner-check-loop")).toHaveLength(1);
    const owner = template!.nodes.find((node) => node.id === "owner")!;
    const check = template!.nodes.find((node) => node.id === "check")!;
    expect([owner.kind, check.kind]).toEqual(["member", "member"]);
    expect([owner.member, check.member]).toEqual([
      `dev-owner@${OWNER_CHECK_PLACEHOLDER_CREW}`,
      `dev-check@${OWNER_CHECK_PLACEHOLDER_CREW}`,
    ]);
    expect(owner.maxVisits).toBe(3);
    const back = template!.edges.find((edge) => edge.from === "check" && edge.to === "owner")!;
    expect(back.when).toMatchObject({ source: "field", key: "check.verdict", op: "equals", value: "fail" });
  });

  it("is built for a named crew", () => {
    const graph = ownerCheckLoopFor("demo");
    expect(graph.nodes.filter((node) => node.kind === "member").map((node) => node.member)).toEqual([
      "dev-owner@demo",
      "dev-check@demo",
    ]);
  });

  it("loops on fail and goes to the human on pass, without spawning a thread", async () => {
    const { host, sends, spawned } = memberHost({ check: [verdict("fail"), verdict("pass")] });
    const app = compileGraph(ownerCheckLoopFor("demo"), host, new MemorySaver());
    await app.invoke(emptyRunState("TASK"), { configurable: { thread_id: "t1" } });
    const state = await app.getState({ configurable: { thread_id: "t1" } });
    expect(state.tasks.flatMap((task) => task.interrupts ?? [])).toHaveLength(1);
    expect(sends.map((send) => `${send.nodeId}:${send.visit}:${send.attempt}`)).toEqual([
      "owner:1:1",
      "check:1:1",
      "owner:2:1",
      "check:2:1",
    ]);
    expect(sends[0]!.address).toBe("dev-owner@demo");
    expect(spawned).toEqual([]);
  });

  it("gives up the loop after three laps and asks the human", async () => {
    const { host, sends } = memberHost({ check: [verdict("fail")] });
    const app = compileGraph(ownerCheckLoopFor("demo"), host, new MemorySaver());
    await app.invoke(emptyRunState("TASK"), { configurable: { thread_id: "t2" } });
    const state = await app.getState({ configurable: { thread_id: "t2" } });
    expect(sends.filter((send) => send.nodeId === "owner")).toHaveLength(3);
    expect(sends.filter((send) => send.nodeId === "check")).toHaveLength(3);
    expect(state.tasks.flatMap((task) => task.interrupts ?? []).map((entry) => (entry.value as { nodeId: string }).nodeId)).toEqual(["gate"]);
  });

  it("retries a broken contract with the next attempt number", async () => {
    const { host, sends } = memberHost({ step: ["no json here", '```json\n{ "verdict": "pass" }\n```'] });
    const graph = memberGraph("dev@crew", {
      fields: [{ name: "verdict", type: "enum", options: ["pass", "fail"] }],
    });
    await compileGraph(graph, host).invoke(emptyRunState("TASK"));
    expect(sends.map((send) => send.attempt)).toEqual([1, 2]);
  });

  it("fails the node instead of spawning when the host cannot reach Crew", async () => {
    const { host, spawned } = memberHost({});
    delete host.sendToMember;
    await expect(compileGraph(memberGraph("dev@crew"), host).invoke(emptyRunState("TASK"))).rejects.toThrow(
      "cannot reach Crew members",
    );
    expect(spawned).toEqual([]);
  });

  it("still spawns an agent node", async () => {
    const { host, spawned, sends } = memberHost({});
    const graph = graphSchema.parse({
      id: "a",
      name: "A",
      nodes: [{ id: "x", label: "X", prompt: "p" }],
      edges: [{ from: START_NODE, to: "x" }, { from: "x", to: END_NODE }],
    });
    await compileGraph(graph, host).invoke(emptyRunState("TASK"));
    expect(spawned).toEqual(["x"]);
    expect(sends).toEqual([]);
  });
});
