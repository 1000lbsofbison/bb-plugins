// Runtime tests against a fake host: no BB server, no models, no network.
// These are the tests that matter, because the runtime is where a cycle can
// run away and where a guard has to hold.
import { describe, expect, it } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import {
  END_NODE,
  START_NODE,
  emptyRunState,
  graphSchema,
  type Graph,
  type NodeExecution,
} from "../lib/graph";
import { compileGraph, GuardStop, type RuntimeHost } from "../lib/runtime";
import { templateById } from "../lib/templates";

/** Records what ran and answers each node with a scripted reply. */
function fakeHost(replies: Record<string, string | string[]>) {
  const spawned: string[] = [];
  const logs: string[] = [];
  const counters: Record<string, number> = {};
  /** What each node asked to run on, so a dropped selection is visible. */
  const executions: Record<string, NodeExecution | null> = {};
  /** Worker ids reported while the node was still running, in order. */
  const attached: Array<{ nodeRunId: string; threadId: string }> = [];
  const host: RuntimeHost = {
    async spawn({ nodeId, execution }) {
      spawned.push(nodeId);
      executions[nodeId] = execution;
      return `thr_${nodeId}_${spawned.length}`;
    },
    async awaitThread(threadId) {
      const nodeId = threadId.split("_")[1]!;
      const reply = replies[nodeId] ?? `output of ${nodeId}`;
      if (Array.isArray(reply)) {
        const index = counters[nodeId] ?? 0;
        counters[nodeId] = index + 1;
        return reply[Math.min(index, reply.length - 1)]!;
      }
      return reply;
    },
    async sendMessage() {},
    async loadDialog() {
      return null;
    },
    async saveDialog() {},
    async onNodeStart() {
      return "node-run";
    },
    async onNodeThread(nodeRunId, threadId) {
      attached.push({ nodeRunId, threadId });
    },
    async onNodeFinish() {},
    async onStateChange() {},
    log(message) {
      logs.push(message);
    },
  };
  return { host, spawned, logs, executions, attached };
}

/**
 * A host for dialogue nodes, modelled on how a real thread behaves: the last
 * message only changes once an answer has been sent into it. That is what
 * makes the interrupt replay testable — a node re-entered from the top reads
 * the same message it read before, exactly as it would against BB.
 */
function fakeDialogHost(script: string[]) {
  const spawned: string[] = [];
  const sent: string[] = [];
  const attached: Array<{ nodeRunId: string; threadId: string }> = [];
  const sessions = new Map<string, { threadId: string; turns: number }>();
  let position = 0;
  const host: RuntimeHost = {
    async spawn({ nodeId }) {
      spawned.push(nodeId);
      return `thr_${nodeId}`;
    },
    async awaitThread() {
      return script[Math.min(position, script.length - 1)]!;
    },
    async sendMessage(_threadId, text) {
      sent.push(text);
      position += 1;
    },
    async loadDialog(nodeId, visit) {
      return sessions.get(`${nodeId}:${visit}`) ?? null;
    },
    async saveDialog(nodeId, visit, session) {
      sessions.set(`${nodeId}:${visit}`, { ...session });
    },
    async onNodeStart() {
      return "node-run";
    },
    async onNodeThread(nodeRunId, threadId) {
      attached.push({ nodeRunId, threadId });
    },
    async onNodeFinish() {},
    async onStateChange() {},
    log() {},
  };
  return { host, spawned, sent, attached };
}

const asks = (question: string) =>
  `Meine Empfehlung steht oben.\n\n\`\`\`json\n{ "done": false, "question": ${JSON.stringify(question)} }\n\`\`\``;
const concludes = (summary: string) =>
  `${summary}\n\n\`\`\`json\n{ "done": true }\n\`\`\``;

const dialogGraph = (maxTurns = 5): Graph =>
  graphSchema.parse({
    id: "dialog-graph",
    name: "Dialog",
    nodes: [
      {
        id: "grill",
        label: "Grillen",
        kind: "dialog",
        prompt: "Grille: {{input}}",
        maxTurns,
      },
    ],
    edges: [
      { from: START_NODE, to: "grill" },
      { from: "grill", to: END_NODE },
    ],
  });

const linear = (): Graph =>
  graphSchema.parse({
    id: "linear",
    name: "Linear",
    nodes: [
      { id: "a", label: "A", prompt: "Erst: {{input}}", maxAttempts: 1 },
      { id: "b", label: "B", prompt: "Then: {{a}}", maxAttempts: 1 },
    ],
    edges: [
      { from: START_NODE, to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: END_NODE },
    ],
  });

describe("runtime", () => {
  it("runs a linear graph and threads output into the next prompt", async () => {
    const seen: string[] = [];
    const { host } = fakeHost({ a: "A-RESULT", b: "B-RESULT" });
    const spy: RuntimeHost = {
      ...host,
      async spawn(args) {
        seen.push(args.prompt);
        return host.spawn(args);
      },
    };
    const app = compileGraph(linear(), spy);
    const out = (await app.invoke(emptyRunState("TASK"))) as {
      outputs: Record<string, string>;
    };
    expect(out.outputs).toEqual({ a: "A-RESULT", b: "B-RESULT" });
    expect(seen[0]).toBe("Erst: TASK");
    expect(seen[1]).toBe("Then: A-RESULT");
  });

  it("follows a cycle and leaves it when the condition flips", async () => {
    // Critic says REWORK twice, then APPROVE — worker must run three times.
    const say = (v: string, why: string) =>
      `${why}\n\n\`\`\`json\n{ "verdict": "${v}", "reason": "${why}" }\n\`\`\``;
    const { host, spawned } = fakeHost({
      critic: [say("REWORK", "einmal"), say("REWORK", "zweimal"), say("APPROVE", "haelt")],
    });
    const graph = templateById("harness-arc")!;
    const app = compileGraph(graph, host, new MemorySaver());
    const config = { configurable: { thread_id: "t1" }, recursionLimit: 100 };

    await app.invoke(emptyRunState("TASK"), config);
    // The run stops at the human gate; resume it.
    await app.invoke(new Command({ resume: "ja" }), config);

    expect(spawned.filter((id) => id === "worker")).toHaveLength(3);
    expect(spawned.filter((id) => id === "critic")).toHaveLength(3);
    expect(spawned).toContain("promote");
  });

  /**
   * A cycle that never converges used to end as an error: the back edge routed
   * into a node that was out of visits, and the guard threw — discarding a
   * result the run already had. The budget now ends the loop instead of the
   * run, and the log says why, so "it stopped looping" is never silent.
   */
  it("leaves a runaway cycle over the budget and carries on", async () => {
    // Critic never approves; the worker's maxVisits must end the loop.
    const { host, spawned, logs } = fakeHost({
      critic: '```json\n{ "verdict": "REWORK", "reason": "nie zufrieden" }\n```',
    });
    const graph = templateById("harness-arc")!;
    const app = compileGraph(graph, host, new MemorySaver());

    await app.invoke(emptyRunState("TASK"), {
      configurable: { thread_id: "t2" },
      recursionLimit: 200,
    });

    const limit = graph.nodes.find((node) => node.id === "worker")!.maxVisits;
    expect(spawned.filter((id) => id === "worker")).toHaveLength(limit);
    expect(logs.join()).toMatch(/limit of \d+ visits is reached/);
  });

  // The guard is still the net: a node entered past its budget — from a
  // resumed checkpoint, say — must not run anyway.
  it("still stops a node entered beyond its budget", async () => {
    const { host } = fakeHost({});
    const graph = linear();
    graph.nodes[0]!.maxVisits = 1;
    const app = compileGraph(graph, host);

    await expect(
      app.invoke({ ...emptyRunState("TASK"), visits: { a: 1 } }),
    ).rejects.toBeInstanceOf(GuardStop);
  });

  it("pauses at a human node and carries the answer into the state", async () => {
    const graph = graphSchema.parse({
      id: "gate",
      name: "Gate",
      nodes: [
        { id: "work", label: "Work", prompt: "w" },
        { id: "ok", label: "Freigabe", kind: "human", prompt: "Freigeben?" },
      ],
      edges: [
        { from: START_NODE, to: "work" },
        { from: "work", to: "ok" },
        { from: "ok", to: END_NODE },
      ],
    });
    const { host } = fakeHost({});
    const app = compileGraph(graph, host, new MemorySaver());
    const config = { configurable: { thread_id: "t3" }, recursionLimit: 50 };

    await app.invoke(emptyRunState("TASK"), config);
    const paused = await app.getState(config);
    expect(paused.tasks.flatMap((task) => task.interrupts ?? []).length).toBe(1);

    const out = (await app.invoke(new Command({ resume: "freigegeben" }), config)) as {
      outputs: Record<string, string>;
    };
    expect(out.outputs.ok).toBe("freigegeben");
  });

  it("runs a fan-out in parallel and merges every branch into the state", async () => {
    const { host, spawned } = fakeHost({
      a: "A",
      b: "B",
      c: "C",
      merge: "MERGED",
    });
    const graph = templateById("parallel-sectioning")!;
    const app = compileGraph(graph, host);
    const out = (await app.invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    })) as { outputs: Record<string, string> };

    expect(out.outputs.a).toBe("A");
    expect(out.outputs.b).toBe("B");
    expect(out.outputs.c).toBe("C");
    expect(out.outputs.merge).toBe("MERGED");
    // merge must come after all three branches
    expect(spawned.indexOf("merge")).toBeGreaterThan(spawned.indexOf("c"));
  });

  it("retries a flaky node and succeeds on the second attempt", async () => {
    const graph = graphSchema.parse({
      id: "flaky",
      name: "Flaky",
      nodes: [{ id: "a", label: "A", prompt: "a", maxAttempts: 3 }],
      edges: [
        { from: START_NODE, to: "a" },
        { from: "a", to: END_NODE },
      ],
    });
    let calls = 0;
    const starts: string[] = [];
    const { host } = fakeHost({});
    const flaky: RuntimeHost = {
      ...host,
      async onNodeStart(nodeId) {
        starts.push(nodeId);
        return `run-${starts.length}`;
      },
      async awaitThread() {
        calls += 1;
        if (calls === 1) throw new Error("Provider threw a fit");
        return "ENDLICH";
      },
    };
    const out = (await compileGraph(graph, flaky).invoke(emptyRunState("T"), {
      recursionLimit: 20,
    })) as { outputs: Record<string, string> };

    expect(out.outputs.a).toBe("ENDLICH");
    expect(calls).toBe(2);
    // Each attempt is recorded, so the UI can show that it took two.
    expect(starts).toEqual(["a", "a"]);
  });

  it("gives up once the attempts are exhausted", async () => {
    const graph = graphSchema.parse({
      id: "doomed",
      name: "Doomed",
      nodes: [{ id: "a", label: "A", prompt: "a", maxAttempts: 2 }],
      edges: [
        { from: START_NODE, to: "a" },
        { from: "a", to: END_NODE },
      ],
    });
    let calls = 0;
    const { host } = fakeHost({});
    const doomed: RuntimeHost = {
      ...host,
      async awaitThread() {
        calls += 1;
        throw new Error("bleibt kaputt");
      },
    };
    await expect(
      compileGraph(graph, doomed).invoke(emptyRunState("T"), { recursionLimit: 20 }),
    ).rejects.toThrow("bleibt kaputt");
    expect(calls).toBe(2);
  });

  /**
   * A stop is a decision about the run, not a flaky attempt. Without the
   * `retryOn` exemption the policy would burn the whole backoff — three
   * attempts at growing intervals — on a result that is already decided.
   */
  it("does not retry a stop, whatever the attempt budget", async () => {
    const graph = graphSchema.parse({
      id: "stopping",
      name: "Stopping",
      nodes: [{ id: "a", label: "A", prompt: "a", maxAttempts: 3 }],
      edges: [
        { from: START_NODE, to: "a" },
        { from: "a", to: END_NODE },
      ],
    });
    const starts: string[] = [];
    const { host } = fakeHost({});
    const stopped: RuntimeHost = {
      ...host,
      async onNodeStart(nodeId) {
        starts.push(nodeId);
        return `run-${starts.length}`;
      },
      async awaitThread() {
        throw new GuardStop("The run was stopped.");
      },
    };
    await expect(
      compileGraph(graph, stopped).invoke(emptyRunState("T"), {
        recursionLimit: 20,
      }),
    ).rejects.toThrow("The run was stopped.");
    expect(starts).toEqual(["a"]);
  });

  /**
   * The same rule for the other way of retrying: a node that routes its
   * failures must not route a stop. Without the exemption the stop would
   * become an error in the state, the failure edge would carry the run on to
   * the next node, and the next spawn would refuse — the run would end
   * stopped eventually, but only after pretending the stop was a failure.
   */
  it("ends the run when a routing node is stopped, rather than routing the stop", async () => {
    const graph = graphSchema.parse({
      id: "routed-stop",
      name: "Routed Stop",
      nodes: [
        {
          id: "primary",
          label: "Primary",
          prompt: "a",
          maxAttempts: 2,
          onError: "route",
        },
        { id: "rescue", label: "Rescue", prompt: "b", maxAttempts: 1 },
      ],
      edges: [
        { from: START_NODE, to: "primary" },
        { from: "primary", to: "rescue", when: { source: "output", key: "", op: "failed", value: "" } },
        { from: "primary", to: END_NODE },
        { from: "rescue", to: END_NODE },
      ],
    });
    const { host, spawned } = fakeHost({});
    const stopped: RuntimeHost = {
      ...host,
      async awaitThread(threadId) {
        if (threadId.startsWith("thr_primary")) {
          throw new GuardStop("The run was stopped.");
        }
        return host.awaitThread(threadId);
      },
    };
    await expect(
      compileGraph(graph, stopped).invoke(emptyRunState("T"), {
        recursionLimit: 20,
      }),
    ).rejects.toThrow("The run was stopped.");
    expect(spawned).toEqual(["primary"]);
  });

  it("never retries a human node, because interrupt throws by design", async () => {
    const graph = graphSchema.parse({
      id: "gate2",
      name: "Gate",
      nodes: [
        { id: "ok", label: "Freigabe", kind: "human", prompt: "?", maxAttempts: 5 },
      ],
      edges: [
        { from: START_NODE, to: "ok" },
        { from: "ok", to: END_NODE },
      ],
    });
    const { host } = fakeHost({});
    const app = compileGraph(graph, host, new MemorySaver());
    const config = { configurable: { thread_id: "t-gate" }, recursionLimit: 20 };
    await app.invoke(emptyRunState("T"), config);
    const paused = await app.getState(config);
    expect(paused.tasks.flatMap((task) => task.interrupts ?? []).length).toBe(1);
  });

  it("retries when the worker breaks its output contract, then parses it", async () => {
    // The payoff of #1 + #2 together: a malformed answer is a failed attempt,
    // not poisoned state, so the worker simply gets another go.
    const graph = graphSchema.parse({
      id: "contract",
      name: "Contract",
      nodes: [
        {
          id: "critic",
          label: "Critic",
          prompt: "check",
          maxAttempts: 3,
          fields: [
            { name: "verdict", type: "enum", options: ["APPROVE", "REWORK"] },
          ],
        },
      ],
      edges: [
        { from: START_NODE, to: "critic" },
        { from: "critic", to: END_NODE },
      ],
    });
    let calls = 0;
    const { host } = fakeHost({});
    const sloppy: RuntimeHost = {
      ...host,
      async awaitThread() {
        calls += 1;
        return calls === 1
          ? "Looks good to me. APPROVE!" // prose only — no JSON block
          : '```json\n{ "verdict": "APPROVE" }\n```';
      },
    };
    const out = (await compileGraph(graph, sloppy).invoke(emptyRunState("T"), {
      recursionLimit: 20,
    })) as { fields: Record<string, Record<string, unknown>> };

    expect(calls).toBe(2);
    expect(out.fields.critic).toEqual({ verdict: "APPROVE" });
  });

  it("makes parsed fields available to the next node's prompt and routing", async () => {
    const graph = graphSchema.parse({
      id: "routed",
      name: "Routed",
      nodes: [
        {
          id: "classify",
          label: "Classify",
          prompt: "classify",
          maxAttempts: 1,
          fields: [{ name: "kind", type: "enum", options: ["BUG", "FEATURE"] }],
        },
        { id: "bug", label: "Bug", prompt: "fix", maxAttempts: 1 },
        { id: "feature", label: "Feature", prompt: "build", maxAttempts: 1 },
      ],
      edges: [
        { from: START_NODE, to: "classify" },
        {
          from: "classify",
          to: "bug",
          when: { source: "field", key: "classify.kind", op: "equals", value: "BUG" },
        },
        { from: "classify", to: "feature" },
        { from: "bug", to: END_NODE },
        { from: "feature", to: END_NODE },
      ],
    });
    const { host, spawned } = fakeHost({
      classify: '{ "kind": "BUG" }',
    });
    await compileGraph(graph, host).invoke(emptyRunState("T"), {
      recursionLimit: 20,
    });
    expect(spawned).toEqual(["classify", "bug"]);
  });

  it("surfaces a failing node instead of silently continuing", async () => {
    const { host } = fakeHost({});
    const failing: RuntimeHost = {
      ...host,
      async awaitThread() {
        throw new Error("Thread kaputt");
      },
    };
    // maxAttempts 1 on this graph, so the first failure is final.
    const app = compileGraph(linear(), failing);
    await expect(app.invoke(emptyRunState("TASK"))).rejects.toThrow("Thread kaputt");
  });

  // The whole point of reporting the worker separately from the result: a
  // node runs for minutes, and everything a reader wants in those minutes —
  // the link into the thread, what it is doing — hangs off this id.
  it("reports the worker while the node is still waiting on it", async () => {
    const { host, attached } = fakeHost({});
    const seenDuringWait: number[] = [];
    const watched: RuntimeHost = {
      ...host,
      async onNodeThread(nodeRunId, threadId) {
        attached.push({ nodeRunId, threadId });
      },
      async awaitThread(threadId) {
        seenDuringWait.push(attached.length);
        return host.awaitThread(threadId);
      },
    };
    const app = compileGraph(linear(), watched);
    await app.invoke(emptyRunState("TASK"));

    // One report per node, each of them before that node's own wait began.
    expect(attached.map((entry) => entry.threadId)).toEqual([
      "thr_a_1",
      "thr_b_2",
    ]);
    expect(seenDuringWait).toEqual([1, 2]);
  });

  it("does not report a worker for a node that never spawns one", async () => {
    const { host, attached } = fakeHost({});
    const failing: RuntimeHost = {
      ...host,
      async spawn() {
        throw new Error("No worker to be had");
      },
    };
    const app = compileGraph(linear(), failing);
    await expect(app.invoke(emptyRunState("TASK"))).rejects.toThrow(
      "No worker to be had",
    );
    expect(attached).toEqual([]);
  });
});

// A skill like `grilling` is an interview: ask, wait, ask the next one. An
// agent node cannot host that — a worker waiting for an answer is idle, and
// idle is what the runtime reads as "finished", so the question would be
// recorded as the result and the run would carry on unanswered.
describe("dialogue nodes", () => {
  it("takes turns: each answer goes into the worker's own thread", async () => {
    const { host, spawned, sent } = fakeDialogHost([
      asks("Welche Datenbank?"),
      asks("And the index?"),
      concludes("Agreed: Postgres with a BTree."),
    ]);
    const app = compileGraph(dialogGraph(), host, new MemorySaver());
    const config = { configurable: { thread_id: "d1" }, recursionLimit: 50 };

    const first = (await app.invoke(emptyRunState("PLAN"), config)) as {
      __interrupt__?: Array<{ value: { question: string } }>;
    };
    expect(first.__interrupt__?.[0]?.value.question).toBe("Welche Datenbank?");

    const second = (await app.invoke(new Command({ resume: "Postgres" }), config)) as {
      __interrupt__?: Array<{ value: { question: string } }>;
    };
    expect(second.__interrupt__?.[0]?.value.question).toBe("And the index?");

    const done = (await app.invoke(new Command({ resume: "BTree" }), config)) as {
      outputs: Record<string, string>;
    };

    expect(sent).toEqual(["Postgres", "BTree"]);
    // One conversation, not one thread per question: the replay after each
    // interrupt must find the open session instead of spawning again.
    expect(spawned).toEqual(["grill"]);
    expect(done.outputs.grill).toContain("Agreed: Postgres with a BTree.");
  });

  it("asks for a summary at the turn limit instead of asking on", async () => {
    const { host, sent } = fakeDialogHost([
      asks("Erste?"),
      asks("Zweite?"),
      asks("Dritte?"),
    ]);
    const app = compileGraph(dialogGraph(1), host, new MemorySaver());
    const config = { configurable: { thread_id: "d2" }, recursionLimit: 50 };

    await app.invoke(emptyRunState("PLAN"), config);
    const out = (await app.invoke(new Command({ resume: "an answer" }), config)) as {
      outputs: Record<string, string>;
      __interrupt__?: unknown[];
    };

    expect(out.__interrupt__).toBeUndefined();
    expect(sent[0]).toBe("an answer");
    expect(sent[1]).toContain("turn limit");
    expect(out.outputs.grill).toBeDefined();
  });

  it("stops when the worker ignores the answer rather than re-asking forever", async () => {
    const { host } = fakeDialogHost([asks("Always the same one?")]);
    // The script never advances, so the message after the answer is the one
    // that was already there — the shape a stuck worker has.
    const stuck: RuntimeHost = { ...host, async sendMessage() {} };
    const app = compileGraph(dialogGraph(), stuck, new MemorySaver());
    const config = { configurable: { thread_id: "d3" }, recursionLimit: 50 };

    await app.invoke(emptyRunState("PLAN"), config);
    await expect(
      app.invoke(new Command({ resume: "Answer" }), config),
    ).rejects.toThrow(/did not react/);
  });

  // A dialogue node re-enters from the top on every interrupt replay, and its
  // conversation is loaded rather than spawned then. The report has to happen
  // on that path too, or the thread link vanishes the moment the node asks its
  // first question — which is exactly when the reader wants to look.
  it("reports the conversation again after an interrupt replay", async () => {
    const { host, attached } = fakeDialogHost([
      asks("What for?"),
      concludes("Verstanden."),
    ]);
    const app = compileGraph(dialogGraph(), host, new MemorySaver());
    const config = { configurable: { thread_id: "d-attach" }, recursionLimit: 50 };
    await app.invoke(emptyRunState("PLAN"), config);
    await app.invoke(new Command({ resume: "For that." }), config);

    expect(attached.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attached.map((entry) => entry.threadId))).toEqual(
      new Set(["thr_grill"]),
    );
  });

  it("rejects a message that breaks the dialogue contract", async () => {
    const { host } = fakeDialogHost(["Just thinking out loud."]);
    const app = compileGraph(dialogGraph(), host, new MemorySaver());
    await expect(
      app.invoke(emptyRunState("PLAN"), {
        configurable: { thread_id: "d4" },
        recursionLimit: 50,
      }),
    ).rejects.toThrow(/done/);
  });
});

/**
 * Dynamic fan-out. The interesting property is not that n branches run — it is
 * that each one gets its *own* element and that the join node afterwards sees
 * all n results. `outputs` cannot express that (its reducer keeps one value
 * per key), which is the whole reason for the `collected` channel.
 */
describe("dynamic fan-out", () => {
  const planReply = (...items: string[]) =>
    `Plan steht.\n\n\`\`\`json\n{ "dateien": ${JSON.stringify(items)} }\n\`\`\``;

  const fanGraph = (maxFanOut = 12): Graph =>
    graphSchema.parse({
      id: "fan",
      name: "Fan",
      maxFanOut,
      nodes: [
        {
          id: "plan",
          label: "Plan",
          prompt: "Plane {{input}}",
          maxAttempts: 1,
          fields: [{ name: "dateien", type: "list" }],
        },
        { id: "review", label: "Review", prompt: "Review {{item}}", maxAttempts: 1 },
        { id: "join", label: "Join", prompt: "Bundle: {{review}}", maxAttempts: 1 },
      ],
      edges: [
        { from: START_NODE, to: "plan" },
        { from: "plan", to: "review", fanOutOver: "dateien" },
        { from: "review", to: "join" },
        { from: "join", to: END_NODE },
      ],
    });

  /** Answers a review branch with the element it was given, so the join
   *  node's prompt shows which branches actually reached it. */
  function fanHost(plan: string) {
    const prompts: string[] = [];
    const logs: string[] = [];
    const byThread = new Map<string, string>();
    let n = 0;
    const host: RuntimeHost = {
      async spawn({ nodeId, prompt }) {
        prompts.push(prompt);
        n += 1;
        const threadId = `thr_${nodeId}_${n}`;
        byThread.set(threadId, prompt);
        return threadId;
      },
      async awaitThread(threadId) {
        const prompt = byThread.get(threadId) ?? "";
        if (threadId.startsWith("thr_plan")) return plan;
        if (threadId.startsWith("thr_review")) {
          return `reviewed: ${prompt.replace("Review ", "").trim()}`;
        }
        return "zusammengefasst";
      },
      async sendMessage() {},
      async loadDialog() {
        return null;
      },
      async saveDialog() {},
      async onNodeStart() {
        return "node-run";
      },
      async onNodeThread() {},
      async onNodeFinish() {},
      async onStateChange() {},
      log(message) {
        logs.push(message);
      },
    };
    return { host, prompts, logs };
  }

  it("runs the target once per element, each with its own item", async () => {
    const { host, prompts } = fanHost(planReply("a.ts", "b.ts", "c.ts"));
    const app = compileGraph(fanGraph(), host);
    await app.invoke(emptyRunState("Task"), { recursionLimit: 50 });

    const reviews = prompts.filter((p) => p.startsWith("Review "));
    expect(reviews).toHaveLength(3);
    expect(reviews.map((p) => p.replace("Review ", "").trim()).sort()).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("hands every branch result to the join node, not just the last", async () => {
    const { host, prompts } = fanHost(planReply("a.ts", "b.ts", "c.ts"));
    const app = compileGraph(fanGraph(), host);
    await app.invoke(emptyRunState("Task"), { recursionLimit: 50 });

    const join = prompts.find((p) => p.startsWith("Bundle:"))!;
    expect(join).toContain("reviewed: a.ts");
    expect(join).toContain("reviewed: b.ts");
    expect(join).toContain("reviewed: c.ts");
  });

  // Each element is its own BB thread, so an unbounded list is an unbounded
  // number of threads. Truncating and saying so beats both failing the run and
  // spawning 200 workers.
  it("caps the branch count at maxFanOut and says what it dropped", async () => {
    const { host, prompts, logs } = fanHost(planReply("1", "2", "3", "4", "5"));
    const app = compileGraph(fanGraph(2), host);
    await app.invoke(emptyRunState("Task"), { recursionLimit: 50 });

    expect(prompts.filter((p) => p.startsWith("Review "))).toHaveLength(2);
    expect(logs.join()).toMatch(/3 skipped/);
  });

  it("ends the run when there is nothing to fan out over", async () => {
    const { host, prompts, logs } = fanHost(planReply());
    const app = compileGraph(fanGraph(), host);
    await app.invoke(emptyRunState("Task"), { recursionLimit: 50 });

    expect(prompts.filter((p) => p.startsWith("Review "))).toHaveLength(0);
    expect(prompts.filter((p) => p.startsWith("Bundle:"))).toHaveLength(0);
    expect(logs.join()).toMatch(/nothing to fan out over/);
  });

  // A branch result must not land in `outputs`: n instances would leave
  // whichever finished last looking like the node's single result.
  it("keeps branch results out of outputs and in collected", async () => {
    const { host } = fanHost(planReply("a.ts", "b.ts"));
    const app = compileGraph(fanGraph(), host);
    const state = await app.invoke(emptyRunState("Task"), {
      recursionLimit: 50,
    });

    expect(state.outputs.review).toBeUndefined();
    expect(state.collected.review).toHaveLength(2);
    expect(state.collected.review.map((entry) => entry.text).sort()).toEqual([
      "reviewed: a.ts",
      "reviewed: b.ts",
    ]);
  });
});

/**
 * The node's model has to survive the trip to `spawn`. It is one assignment in
 * the runtime, but it is the assignment that decides whether the whole feature
 * does anything — and it would fail silently: the worker simply runs on the
 * inherited model and nothing anywhere says so.
 */
describe("per-node execution reaches the host", () => {
  const graph = (): Graph =>
    graphSchema.parse({
      id: "exec",
      name: "Exec",
      nodes: [
        {
          id: "stark",
          label: "Stark",
          prompt: "a",
          providerId: "claude-code",
          model: "claude-opus-5",
          reasoningLevel: "high",
        },
        { id: "sparsam", label: "Sparsam", prompt: "b" },
      ],
      edges: [
        { from: START_NODE, to: "stark" },
        { from: "stark", to: "sparsam" },
        { from: "sparsam", to: END_NODE },
      ],
    });

  it("hands an explicit model to the spawn and leaves the other inheriting", async () => {
    const { host, executions } = fakeHost({});
    await compileGraph(graph(), host).invoke(emptyRunState("go"));
    expect(executions.stark).toEqual({
      providerId: "claude-code",
      model: "claude-opus-5",
      reasoningLevel: "high",
      serviceTier: null,
    });
    // The negative half: a node without a selection must not inherit its
    // neighbour's, and must not invent one.
    expect(executions.sparsam).toBeNull();
  });
});

/**
 * Subgraphs at run time. The one that had to be verified before anything else
 * was built: an `interrupt()` *inside* an embedded graph has to suspend the
 * whole run and resume across the boundary.
 *
 * A nested `invoke()` would not do that — it returns `__interrupt__` in its
 * result instead of throwing, so the parent would read an unanswered question
 * as the child's answer and walk on. That is the dialogue-node bug one level
 * up, and it is why the child is added as a compiled graph rather than called
 * from a function.
 */
describe("subgraphs", () => {
  const child = (): Graph =>
    graphSchema.parse({
      id: "child",
      name: "Child",
      nodes: [
        { id: "work", label: "Work", prompt: "do {{input}}" },
        { id: "question", label: "Question", kind: "human", prompt: "does this fit?" },
      ],
      edges: [
        { from: START_NODE, to: "work" },
        { from: "work", to: "question" },
        { from: "question", to: END_NODE },
      ],
    });

  const parent = (): Graph =>
    graphSchema.parse({
      id: "parent",
      name: "Parent",
      nodes: [
        { id: "before", label: "Before", prompt: "prepare" },
        { id: "embedded", label: "Embedded", kind: "subgraph", graphId: "child" },
        { id: "after", label: "After", prompt: "use {{work}}" },
      ],
      edges: [
        { from: START_NODE, to: "before" },
        { from: "before", to: "embedded" },
        { from: "embedded", to: "after" },
        { from: "after", to: END_NODE },
      ],
    });

  const resolve = (id: string) => (id === "child" ? child() : null);

  it("runs the embedded graph's nodes and shares their results", async () => {
    const noApproval = child();
    noApproval.nodes = [noApproval.nodes[0]!];
    noApproval.edges = [
      { from: START_NODE, to: "work", when: null, label: "", fanOutOver: "" },
      { from: "work", to: END_NODE, when: null, label: "", fanOutOver: "" },
    ];
    const { host, spawned } = fakeHost({});
    const result = await compileGraph(parent(), host, undefined, () => noApproval).invoke(
      emptyRunState("go"),
    );
    // The child's node ran as part of this run, under its own id.
    expect(spawned).toEqual(["before", "work", "after"]);
    expect(Object.keys(result.outputs).sort()).toEqual([
      "after",
      "before",
      "work",
    ]);
  });

  it("suspends the whole run on an approval inside the child and resumes", async () => {
    const { host, spawned } = fakeHost({});
    const saver = new MemorySaver();
    const app = compileGraph(parent(), host, saver, resolve);
    const config = { configurable: { thread_id: "sub-1" } };

    await app.invoke(emptyRunState("go"), config);
    // The parent must be the one holding the question, or the server's own
    // drive loop would never see it.
    const pending = (await app.getState(config)).tasks.flatMap(
      (task) => task.interrupts ?? [],
    );
    expect(pending).toHaveLength(1);
    expect((pending[0]!.value as { label: string }).label).toBe("Question");
    // And the node after the subgraph must not have run yet — the whole point.
    expect(spawned).not.toContain("after");

    const done = await app.invoke(new Command({ resume: "yes" }), config);
    expect(done.outputs.question).toBe("yes");
    expect(spawned).toContain("after");
  });

  // Compiling must fail loudly rather than skip a node whose graph vanished
  // between authoring and running.
  it("refuses to compile a subgraph whose graph is gone", () => {
    expect(() => compileGraph(parent(), fakeHost({}).host, undefined, () => null)).toThrow(
      /which does not exist/,
    );
  });
});
