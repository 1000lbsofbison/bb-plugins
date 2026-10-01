// Member nodes against the fake plugin host: the calls that reach Crew, the
// refusals at save and start, and — the E5 criterion — that a resume after a
// reload does not send the member the same task twice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import graphStudio from "../server";
import { END_NODE, START_NODE, graphSchema, type Graph } from "../lib/graph";

const open: FakePluginHost[] = [];

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

const memberGraph = (id: string, member = "dev-owner@demo"): Graph =>
  graphSchema.parse({
    id,
    name: "Member",
    nodes: [{ id: "owner", label: "Owner", kind: "member", member, prompt: "Do: {{input}}", maxAttempts: 1 }],
    edges: [
      { from: START_NODE, to: "owner" },
      { from: "owner", to: END_NODE },
    ],
  });

type Reply = { status: string; text: string | null };

/**
 * Crew as seen through `plugins.callRpc`: known members, a message counter,
 * and a scripted `memberReply`. Every answer goes through the caller's
 * `outputSchema`, as the host does.
 */
function crewStub(options: { members?: Record<string, string>; reply?: () => Reply; missing?: boolean } = {}) {
  const members = options.members ?? { "dev-owner@demo": "thr_member_owner", "dev-check@demo": "thr_member_check" };
  const sent: Array<Record<string, unknown>> = [];
  const callRpc = async (args: { method: string; input: Record<string, unknown>; outputSchema: { parse(value: unknown): unknown } }) => {
    if (options.missing) throw new Error('Plugin "crew" is not installed.');
    const input = args.input;
    const answer = (() => {
      switch (args.method) {
        case "listMembers":
          return {
            contractVersion: 1,
            members: Object.entries(members).map(([address, threadId]) => ({
              memberId: address, address, crew: "demo", key: address.split("@")[0], lead: false, role: "writer", threadId, shift: 1, activity: "idle",
            })),
          };
        case "resolveMember": {
          const address = String(input.address);
          const threadId = members[address];
          return threadId
            ? { contractVersion: 1, member: { memberId: address, address, crew: "demo", key: address.split("@")[0], lead: false, role: "", threadId, shift: 1, activity: "idle" }, error: null }
            : { contractVersion: 1, member: null, error: `No member "${address}" in this project.` };
        }
        case "sendToMember":
          sent.push(input);
          return { contractVersion: 1, messageId: `msg_${sent.length}`, status: "delivered", duplicate: false, error: null };
        case "memberReply": {
          const reply = options.reply?.() ?? { status: "completed", text: "done by the member" };
          return { contractVersion: 1, ...reply, eventCursor: reply.status === "completed" ? 42 : null, threadId: "thr_member_owner" };
        }
        default:
          throw new Error(`unexpected ${args.method}`);
      }
    })();
    return args.outputSchema.parse(answer);
  };
  return { callRpc, sent };
}

function sdk(crew: ReturnType<typeof crewStub>, extra: Record<string, unknown> = {}) {
  return {
    plugins: { callRpc: crew.callRpc },
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: "env-1", projectId: "proj_demo", providerId: "pi" }),
      spawn: async () => ({ id: "thr_worker_1" }),
      wait: async () => ({}),
      output: async () => ({ output: "worker answer" }),
      stop: async () => ({ ok: true }),
      send: async () => ({ ok: true }),
      events: { list: async () => [] },
      ...extra,
    },
    // Shaped like BB's answer (BBP-21): without a providerId only the default
    // provider's catalogue comes back, so a check that does not name the
    // provider never sees claude-code's models.
    providers: {
      models: async ({ providerId }: { providerId?: string } = {}) => ({
        providers: [
          { id: "pi", available: true },
          { id: "claude-code", available: true },
        ],
        models:
          providerId === "claude-code"
            ? [{ id: "claude-haiku-4-5-20251001", model: "claude-haiku-4-5-20251001" }]
            : [],
        modelLoadError: null,
      }),
    },
  };
}

function load(crew: ReturnType<typeof crewStub>, extra?: Record<string, unknown>) {
  const host = createFakePluginHost({ pluginId: "graph-studio", sdk: sdk(crew, extra) as never });
  open.push(host);
  graphStudio(host.bb);
  return host;
}

async function run(host: FakePluginHost, graphId: string) {
  const started = (await host.harness.behavior.callRpc("startRun", {
    graphId,
    input: "the task",
    threadId: "thr_parent",
    projectId: "proj_demo",
  })) as { run: { id: string } };
  return started.run.id;
}

async function getRun(host: FakePluginHost, runId: string) {
  return ((await host.harness.behavior.callRpc("getRun", { id: runId })) as {
    run: { status: string; error: string | null; state: { outputs: Record<string, string> }; nodeRuns: Array<{ nodeId: string; childThreadId: string | null; status: string; inputTokens: number | null }> };
  }).run;
}

describe("saving a graph with member nodes", () => {
  it("is refused with a clear message when Crew is not installed", async () => {
    const host = load(crewStub({ missing: true }));
    await expect(
      host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-missing"), threadId: "thr_parent" }),
    ).rejects.toThrow(/Member nodes cannot run: The Crew plugin \("crew"\) is not installed or not reachable/);
    expect(((await host.harness.behavior.callRpc("getGraph", { id: "m-missing" })) as { graph: unknown }).graph).toBeNull();
  });

  it("is refused for a member Crew does not know", async () => {
    const host = load(crewStub());
    await expect(
      host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-ghost", "ghost@demo"), threadId: "thr_parent" }),
    ).rejects.toThrow('"Owner" names the member "ghost@demo", which Crew does not know in this project');
  });

  it("goes through for a known member", async () => {
    const host = load(crewStub());
    const saved = (await host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-ok"), threadId: "thr_parent" })) as { graph: Graph };
    expect(saved.graph.id).toBe("m-ok");
  });

  it("does not ask Crew for a graph of agents, even when Crew is missing", async () => {
    const host = load(crewStub({ missing: true }));
    const agents = graphSchema.parse({ id: "plain", name: "Plain", nodes: [{ id: "a", label: "A", prompt: "p" }], edges: [{ from: START_NODE, to: "a" }, { from: "a", to: END_NODE }] });
    await expect(host.harness.behavior.callRpc("saveGraph", { graph: agents })).resolves.toBeTruthy();
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc")).toEqual([]);
  });

  it("is refused by the agent tool too, and the tool says why", async () => {
    const host = load(crewStub({ missing: true }));
    const result = await host.harness.behavior.callAgentTool(
      "graph_studio_save",
      { json: JSON.stringify(memberGraph("m-tool")) },
      { projectId: "proj_demo", threadId: "thr_parent" },
    );
    expect(JSON.stringify(result)).toContain("Not saved. Member nodes cannot run");
  });
});

describe("starting a run with member nodes", () => {
  it("is refused when the member became unknown after saving", async () => {
    const crew = crewStub();
    const host = load(crew);
    await host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-start"), threadId: "thr_parent" });
    delete (crew as unknown as { callRpc: unknown }).callRpc;
    // Same host, a Crew that now answers "not installed".
    host.harness.inspection.sdk.stub("plugins.callRpc", async () => {
      throw new Error('Plugin "crew" is not installed.');
    });
    await expect(run(host, "m-start")).rejects.toThrow(/Member nodes cannot run: The Crew plugin/);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("sends to the member with runId:gen:nodeId:visit:attempt and spawns no thread", async () => {
    const crew = crewStub();
    const host = load(crew);
    await host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-run"), threadId: "thr_parent" });
    const runId = await run(host, "m-run");
    await vi.waitFor(async () => expect((await getRun(host, runId)).status).toBe("done"));
    expect(crew.sent).toHaveLength(1);
    expect(crew.sent[0]).toMatchObject({
      projectId: "proj_demo",
      address: "dev-owner@demo",
      from: "graph-studio",
      correlationId: `${runId}:0:owner:1:1`,
    });
    expect(String(crew.sent[0]!.body)).toContain("Do: the task");
    const row = await getRun(host, runId);
    expect(row.state.outputs.owner).toBe("done by the member");
    expect(row.nodeRuns[0]).toMatchObject({ childThreadId: "thr_member_owner", status: "done", inputTokens: null });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("skips the model check for member nodes only", async () => {
    const crew = crewStub();
    const host = load(crew);
    const withModel = graphSchema.parse({
      ...memberGraph("m-model"),
      nodes: [{ ...memberGraph("m-model").nodes[0]!, providerId: "nope", model: "nope-1" }],
    });
    await host.harness.behavior.callRpc("saveGraph", { graph: withModel, threadId: "thr_parent" });
    const runId = await run(host, "m-model");
    await vi.waitFor(async () => expect((await getRun(host, runId)).status).toBe("done"));

    // The positive case: the same bogus choice on an agent node is refused.
    const agent = graphSchema.parse({
      id: "a-model",
      name: "A",
      nodes: [{ id: "a", label: "A", prompt: "p", providerId: "nope", model: "nope-1" }],
      edges: [{ from: START_NODE, to: "a" }, { from: "a", to: END_NODE }],
    });
    await host.harness.behavior.callRpc("saveGraph", { graph: agent });
    const agentRun = await run(host, "a-model");
    await vi.waitFor(async () => expect((await getRun(host, agentRun)).status).toBe("failed"));
    expect((await getRun(host, agentRun)).error).toContain("Unknown model choice");
  });

  it("accepts a model the named provider lists although it is not the default provider's", async () => {
    const host = load(crewStub({ reply: () => ({ status: "done", text: "ok" }) }));
    const graph = graphSchema.parse({
      id: "haiku-model",
      name: "H",
      nodes: [{ id: "a", label: "A", prompt: "p", providerId: "claude-code", model: "claude-haiku-4-5-20251001" }],
      edges: [{ from: START_NODE, to: "a" }, { from: "a", to: END_NODE }],
    });
    await host.harness.behavior.callRpc("saveGraph", { graph, threadId: "thr_parent" });
    const runId = await run(host, "haiku-model");
    await vi.waitFor(async () => expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1));
    expect((await getRun(host, runId)).error ?? "").not.toContain("Unknown model choice");
  });

  it("still refuses a bogus model of a provider that has a catalogue", async () => {
    const host = load(crewStub({ reply: () => ({ status: "done", text: "ok" }) }));
    const graph = graphSchema.parse({
      id: "bogus-model",
      name: "B",
      nodes: [{ id: "a", label: "A", prompt: "p", providerId: "claude-code", model: "claude-bogus-9" }],
      edges: [{ from: START_NODE, to: "a" }, { from: "a", to: END_NODE }],
    });
    await host.harness.behavior.callRpc("saveGraph", { graph, threadId: "thr_parent" });
    const runId = await run(host, "bogus-model");
    await vi.waitFor(async () => expect((await getRun(host, runId)).status).toBe("failed"));
    expect((await getRun(host, runId)).error).toContain('names the model "claude-bogus-9"');
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("fails the node with Crew's reason when the member's answer failed", async () => {
    const host = load(crewStub({ reply: () => ({ status: "failed", text: "turn crashed" }) }));
    await host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-fail"), threadId: "thr_parent" });
    const runId = await run(host, "m-fail");
    await vi.waitFor(async () => expect((await getRun(host, runId)).status).toBe("failed"));
    expect((await getRun(host, runId)).error).toContain("failed: turn crashed");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  });
});

describe("the run's goodbye leaves members alone", () => {
  it("stops and tells the agent worker but not the member thread when the run is stopped", async () => {
    const crew = crewStub({ reply: () => ({ status: "running", text: null }) });
    // The agent worker never finishes; the member's reply is "running" — then
    // the run is stopped, and both are left behind.
    const host = load(crew, { wait: () => new Promise(() => {}) });
    const graph = graphSchema.parse({
      id: "mixed",
      name: "Mixed",
      nodes: [
        { id: "owner", label: "Owner", kind: "member", member: "dev-owner@demo", prompt: "p" },
        { id: "work", label: "Work", prompt: "p" },
        { id: "split", label: "Split", kind: "note" },
      ],
      edges: [
        { from: START_NODE, to: "split" },
        { from: "split", to: "owner" },
        { from: "split", to: "work" },
        { from: "owner", to: END_NODE },
        { from: "work", to: END_NODE },
      ],
    });
    await host.harness.behavior.callRpc("saveGraph", { graph, threadId: "thr_parent" });
    const runId = await run(host, "mixed");
    await vi.waitFor(async () => {
      const row = await getRun(host, runId);
      expect(row.nodeRuns.map((entry) => entry.childThreadId).sort()).toEqual(["thr_member_owner", "thr_worker_1"]);
    });
    await host.harness.behavior.callRpc("stopRun", { runId });
    // The agent's retry policy takes one backoff (about a second) to notice.
    await vi.waitFor(async () => expect((await getRun(host, runId)).status).toBe("stopped"), { timeout: 8_000 });
    await vi.waitFor(() => expect(host.harness.inspection.sdk.callsTo("threads.send").length).toBeGreaterThan(0));
    const stopped = host.harness.inspection.sdk.callsTo("threads.stop").map((call) => (call[0] as { threadId: string }).threadId);
    const told = host.harness.inspection.sdk.callsTo("threads.send").map((call) => (call[0] as { threadId: string }).threadId);
    expect(stopped).toEqual(["thr_worker_1"]);
    expect(told).toEqual(["thr_worker_1"]);
  });
});

describe("resume after a reload", () => {
  it("polls the reply of the message already sent instead of sending again", async () => {
    let answered = false;
    const crew = crewStub({ reply: () => (answered ? { status: "completed", text: "the member's answer" } : { status: "running", text: null }) });
    const host = createFakePluginHost({ pluginId: "graph-studio", sdk: sdk(crew) as never });
    graphStudio(host.bb);
    await host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-resume"), threadId: "thr_parent" });
    const runId = await run(host, "m-resume");
    await vi.waitFor(() => expect(crew.sent).toHaveLength(1));

    // The plugin goes down while the member is still at work.
    const next = await host.harness.lifecycle.reload(graphStudio);
    open.push(next);
    next.harness.inspection.sdk.stub("plugins.callRpc", crew.callRpc as never);
    answered = true;
    const service = next.harness.behavior.runService("resume-orphans");
    await vi.waitFor(async () => expect((await getRun(next, runId)).status).toBe("done"), { timeout: 10_000 });
    service.controller.abort();
    await service.done;

    // One message in total, and the answer is the one to that message.
    expect(crew.sent).toHaveLength(1);
    expect((await getRun(next, runId)).state.outputs.owner).toBe("the member's answer");
    const replies = next.harness.inspection.sdk
      .callsTo("plugins.callRpc")
      .map((call) => call[0] as { method: string; input: { messageId?: string } })
      .filter((call) => call.method === "memberReply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((call) => call.input.messageId === "msg_1")).toBe(true);
    // The crashed attempt's row is reused, not doubled.
    expect((await getRun(next, runId)).nodeRuns).toHaveLength(1);
  });

  it("does send again for a new visit (positive case: the ledger is per visit)", async () => {
    const crew = crewStub();
    const host = load(crew);
    const loop = graphSchema.parse({
      id: "m-loop",
      name: "Loop",
      nodes: [{ id: "owner", label: "Owner", kind: "member", member: "dev-owner@demo", prompt: "p", maxVisits: 2 }],
      edges: [
        { from: START_NODE, to: "owner" },
        { from: "owner", to: "owner", when: { source: "output", key: "", op: "visitsBelow", value: "2" } },
        { from: "owner", to: END_NODE },
      ],
    });
    await host.harness.behavior.callRpc("saveGraph", { graph: loop, threadId: "thr_parent" });
    const runId = await run(host, "m-loop");
    await vi.waitFor(async () => expect((await getRun(host, runId)).status).toBe("done"));
    expect(crew.sent.map((entry) => entry.correlationId)).toEqual([`${runId}:0:owner:1:1`, `${runId}:0:owner:2:1`]);
  });
});

describe("rerun from a checkpoint (BBP-15)", () => {
  async function checkpointBefore(host: FakePluginHost, runId: string, nodeId: string) {
    const { checkpoints } = (await host.harness.behavior.callRpc("listCheckpoints", { runId })) as {
      checkpoints: Array<{ checkpointId: string; next: string[] }>;
    };
    const point = checkpoints.find((entry) => entry.next.includes(nodeId));
    expect(point).toBeDefined();
    return point!.checkpointId;
  }

  it("sends the member one new message under the next generation", async () => {
    let answer = 0;
    const crew = crewStub({ reply: () => ({ status: "completed", text: `answer ${++answer}` }) });
    const host = load(crew);
    await host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-rerun"), threadId: "thr_parent" });
    const runId = await run(host, "m-rerun");
    await vi.waitFor(async () => expect((await getRun(host, runId)).status).toBe("done"));
    expect(crew.sent).toHaveLength(1);

    await host.harness.behavior.callRpc("rerunFrom", { runId, checkpointId: await checkpointBefore(host, runId, "owner") });
    await vi.waitFor(async () => {
      const row = await getRun(host, runId);
      expect(row.status).toBe("done");
      expect(crew.sent).toHaveLength(2);
    });
    expect(crew.sent.map((entry) => entry.correlationId)).toEqual([`${runId}:0:owner:1:1`, `${runId}:1:owner:1:1`]);
    // The new reply, not the one to the first delivery.
    expect((await getRun(host, runId)).state.outputs.owner).toBe("answer 2");
  });

  it("does not raise the generation on a resume after a reload (negative)", async () => {
    let answered = false;
    const crew = crewStub({ reply: () => (answered ? { status: "completed", text: "late answer" } : { status: "running", text: null }) });
    const host = createFakePluginHost({ pluginId: "graph-studio", sdk: sdk(crew) as never });
    graphStudio(host.bb);
    await host.harness.behavior.callRpc("saveGraph", { graph: memberGraph("m-gen-resume"), threadId: "thr_parent" });
    const runId = await run(host, "m-gen-resume");
    await vi.waitFor(() => expect(crew.sent).toHaveLength(1));
    const next = await host.harness.lifecycle.reload(graphStudio);
    open.push(next);
    next.harness.inspection.sdk.stub("plugins.callRpc", crew.callRpc as never);
    answered = true;
    const service = next.harness.behavior.runService("resume-orphans");
    await vi.waitFor(async () => expect((await getRun(next, runId)).status).toBe("done"), { timeout: 10_000 });
    service.controller.abort();
    expect(crew.sent.map((entry) => entry.correlationId)).toEqual([`${runId}:0:owner:1:1`]);
  });
});
