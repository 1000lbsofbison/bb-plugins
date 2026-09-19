// Roadmap #16: a node that gives up is a route, not the end of the run.
//
// Three layers, and each of them can be wrong on its own: the condition has to
// read the outcome, the validator has to refuse the two shapes where a failure
// edge is decoration, and the runtime has to record the failure and carry on
// instead of throwing. The negative cases matter more than usual here — a
// `failed` edge that never fires looks exactly like a run that never failed.
import { describe, expect, it } from "vitest";
import {
  END_NODE,
  START_NODE,
  emptyRunState,
  evaluateCondition,
  graphSchema,
  renderPrompt,
  routeFrom,
  validateGraph,
  type Graph,
  type RunState,
} from "../lib/graph";
import { conditionLabel, edgeLabel } from "../lib/layout";
import { describeGraph } from "../lib/describe";
import { compileGraph, type RuntimeHost } from "../lib/runtime";
import { templateById } from "../lib/templates";

const when = (op: "failed" | "succeeded", key = "") =>
  ({ source: "output" as const, key, op, value: "" });

/* ── the condition ─────────────────────────────────────────────────────── */

describe("the failed and succeeded conditions", () => {
  const ran = (errors: Record<string, string>, visits: Record<string, number>): RunState => ({
    ...emptyRunState("TASK"),
    errors,
    visits,
  });

  it("is true for a node that recorded an error", () => {
    expect(
      evaluateCondition(when("failed"), ran({ build: "boom" }, { build: 1 }), "build"),
    ).toBe(true);
  });

  it("is false for a node that ran and did not fail", () => {
    expect(
      evaluateCondition(when("failed"), ran({ build: "" }, { build: 1 }), "build"),
    ).toBe(false);
  });

  it("is false for a node that has not run at all", () => {
    expect(evaluateCondition(when("failed"), ran({}, {}), "build")).toBe(false);
  });

  it("reads the named node rather than the edge's source", () => {
    const state = ran({ build: "boom" }, { build: 1 });
    expect(evaluateCondition(when("failed", "build"), state, "report")).toBe(true);
    expect(evaluateCondition(when("failed"), state, "report")).toBe(false);
  });

  it("calls a node succeeded once it has run without an error", () => {
    expect(
      evaluateCondition(when("succeeded"), ran({ build: "" }, { build: 1 }), "build"),
    ).toBe(true);
  });

  /**
   * The case that makes `succeeded` more than "not failed". Without the visit
   * count it would hold from the first step of the run, and an edge meant as
   * "once the build is through" would fire before anything was built.
   */
  it("does not call a node that never ran succeeded", () => {
    expect(evaluateCondition(when("succeeded"), ran({}, {}), "build")).toBe(false);
  });

  it("does not call a failed node succeeded", () => {
    expect(
      evaluateCondition(when("succeeded"), ran({ build: "boom" }, { build: 1 }), "build"),
    ).toBe(false);
  });
});

describe("routing on a failure", () => {
  const graph = (): Graph =>
    graphSchema.parse({
      id: "route-on-failure",
      name: "Route on failure",
      nodes: [
        { id: "build", label: "Build", prompt: "x", onError: "route" },
        { id: "rescue", label: "Rescue", prompt: "x" },
        { id: "ship", label: "Ship", prompt: "x" },
      ],
      edges: [
        { from: START_NODE, to: "build" },
        { from: "build", to: "rescue", when: when("failed") },
        { from: "build", to: "ship" },
        { from: "rescue", to: END_NODE },
        { from: "ship", to: END_NODE },
      ],
    });

  it("takes the failure edge when the node gave up", () => {
    const state = { ...emptyRunState("T"), errors: { build: "boom" }, visits: { build: 1 } };
    expect(routeFrom(graph(), "build", state).next).toBe("rescue");
  });

  it("falls through to the unconditional edge when it did not", () => {
    const state = { ...emptyRunState("T"), errors: { build: "" }, visits: { build: 1 } };
    expect(routeFrom(graph(), "build", state).next).toBe("ship");
  });
});

/* ── the prompt ────────────────────────────────────────────────────────── */

describe("{{node.error}}", () => {
  it("renders why the node gave up", () => {
    const state = { ...emptyRunState("T"), errors: { build: "no compiler" } };
    expect(renderPrompt("Failed with: {{build.error}}", state)).toBe(
      "Failed with: no compiler",
    );
  });

  it("renders empty while nothing has failed", () => {
    expect(renderPrompt("Failed with: {{build.error}}", emptyRunState("T"))).toBe(
      "Failed with: ",
    );
  });

  /** A field somebody declared and named `error` is still their field. */
  it("leaves a declared field of that name alone", () => {
    const state: RunState = {
      ...emptyRunState("T"),
      fields: { build: { error: "the declared one" } },
      errors: { build: "the recorded one" },
    };
    expect(renderPrompt("{{build.error}}", state)).toBe("the declared one");
  });
});

/* ── the validator ─────────────────────────────────────────────────────── */

const messages = (graph: unknown, level?: "error" | "warning") =>
  validateGraph(graphSchema.parse(graph))
    .filter((problem) => level === undefined || problem.level === level)
    .map((problem) => problem.message);

const twoNodes = (build: Record<string, unknown>, edge: Record<string, unknown>) => ({
  id: "g",
  name: "G",
  nodes: [
    { id: "build", label: "Build", prompt: "x", ...build },
    { id: "rescue", label: "Rescue", prompt: "x" },
  ],
  edges: [
    { from: START_NODE, to: "build" },
    { from: "build", to: "rescue", ...edge },
    { from: "rescue", to: END_NODE },
  ],
});

describe("validation of failure routing", () => {
  it("refuses a failure edge on a node that ends the run", () => {
    expect(messages(twoNodes({}, { when: when("failed") }), "error")).toContain(
      'Edge build → rescue is taken when "Build" fails, but "Build" ends the run when it fails; the edge can never be taken. Set that node to "route the failure".',
    );
  });

  it("accepts the same edge once the node routes its failure", () => {
    expect(
      messages(twoNodes({ onError: "route" }, { when: when("failed") })),
    ).toEqual([]);
  });

  it("refuses a failure edge naming a node that does not exist", () => {
    expect(
      messages(twoNodes({ onError: "route" }, { when: when("failed", "nope") }), "error"),
    ).toContain(
      'Edge build → rescue asks whether "nope" failed, but there is no such node.',
    );
  });

  it("refuses a failure edge on a node that cannot fail at all", () => {
    expect(
      messages(twoNodes({ kind: "note", prompt: "" }, { when: when("failed") }), "error"),
    ).toContain(
      'Edge build → rescue is taken when "Build" fails, but "Build" is a Note node and cannot fail; the edge can never be taken. Set that node to "route the failure".',
    );
  });

  /** Redundant rather than impossible, so a warning and not an error. */
  it("warns that a success edge on a stopping node always holds", () => {
    expect(messages(twoNodes({}, { when: when("succeeded") }), "warning")).toContain(
      'Edge build → rescue is taken when "Build" succeeds, but "Build" ends the run when it fails, so the condition always holds.',
    );
  });

  it("warns when a node routes its failure and no edge catches it", () => {
    expect(messages(twoNodes({ onError: "route" }, {}), "warning")).toContain(
      '"Build" routes its failure onward, but no edge asks whether it failed; a failed attempt would carry on as if the node had produced nothing.',
    );
  });

  it("says nothing once an edge catches it", () => {
    expect(
      messages(twoNodes({ onError: "route" }, { when: when("failed") }), "warning"),
    ).toEqual([]);
  });

  it("warns that a node which spawns no worker cannot route a failure", () => {
    expect(
      messages(twoNodes({ kind: "note", prompt: "", onError: "route" }, {}), "warning"),
    ).toContain(
      '"Build" is set to route its failure, but a Note node spawns no worker and cannot fail; the setting has no effect.',
    );
  });

  /**
   * n branches at once have no single outcome. Refused rather than warned
   * about: whichever branch happened to finish last would decide whether the
   * edge fires, which is a coin toss wearing a condition's clothes.
   */
  it("refuses to route the failure of a node behind a dynamic fan-out", () => {
    const problems = messages(
      {
        id: "g",
        name: "G",
        nodes: [
          {
            id: "plan",
            label: "Plan",
            prompt: "x",
            fields: [{ name: "parts", type: "list" }],
          },
          { id: "work", label: "Work", prompt: "{{item}}", onError: "route" },
        ],
        edges: [
          { from: START_NODE, to: "plan" },
          { from: "plan", to: "work", fanOutOver: "plan.parts" },
          { from: "work", to: END_NODE },
        ],
      },
      "error",
    );
    expect(problems).toContain(
      '"Work" runs once per entry of a fan-out, so it has no single outcome to route on; it cannot route its failure.',
    );
  });

  it("refuses {{node.error}} on a node that ends the run when it fails", () => {
    expect(
      messages(
        {
          id: "g",
          name: "G",
          nodes: [
            { id: "build", label: "Build", prompt: "x" },
            { id: "rescue", label: "Rescue", prompt: "after {{build.error}}" },
          ],
          edges: [
            { from: START_NODE, to: "build" },
            { from: "build", to: "rescue" },
            { from: "rescue", to: END_NODE },
          ],
        },
        "error",
      ),
    ).toContain(
      '"Rescue" reads {{build.error}}, but "build" ends the run when it fails, so it never leaves an error behind.',
    );
  });
});

/* ── the runtime ───────────────────────────────────────────────────────── */

/** Fails the first `failFor[nodeId]` attempts of a node, then answers. */
function makeHost(failFor: Record<string, number> = {}) {
  const spawned: string[] = [];
  const logs: string[] = [];
  const prompts: Record<string, string> = {};
  const finished: Array<{ status: string; error: string | null }> = [];
  const attempts: Record<string, number> = {};
  const host: RuntimeHost = {
    async spawn({ nodeId, prompt }) {
      spawned.push(nodeId);
      prompts[nodeId] = prompt;
      return `thr_${nodeId}_${spawned.length}`;
    },
    async awaitThread(threadId) {
      const nodeId = threadId.split("_").slice(1, -1).join("_");
      const attempt = (attempts[nodeId] = (attempts[nodeId] ?? 0) + 1);
      if (attempt <= (failFor[nodeId] ?? 0)) {
        throw new Error(`${nodeId} broke on attempt ${attempt}`);
      }
      return `output of ${nodeId}`;
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
    async onNodeFinish(_id, patch) {
      finished.push({ status: patch.status, error: patch.error });
    },
    async onStateChange() {},
    log(message) {
      logs.push(message);
    },
    // No real backoff: the point of these tests is what the node does after
    // its attempts, not how long it waits between them.
    async wait() {},
  };
  return { host, spawned, logs, prompts, finished };
}

const chain = (onError: "stop" | "route", maxAttempts = 2, maxVisits = 1): Graph =>
  graphSchema.parse({
    id: "chain",
    name: "Chain",
    nodes: [
      {
        id: "primary",
        label: "Primary",
        prompt: "Do: {{input}}",
        maxAttempts,
        maxVisits,
        onError,
      },
      { id: "rescue", label: "Rescue", prompt: "After: {{primary.error}}", maxAttempts: 1 },
      { id: "report", label: "Report", prompt: "Got: {{primary}}", maxAttempts: 1 },
    ],
    edges: [
      { from: START_NODE, to: "primary" },
      { from: "primary", to: "rescue", when: when("failed") },
      { from: "primary", to: "report" },
      { from: "rescue", to: END_NODE },
      { from: "report", to: END_NODE },
    ],
  });

describe("a node that routes its failure", () => {
  it("carries the run down the failure edge instead of ending it", async () => {
    const { host, spawned } = makeHost({ primary: 99 });
    const out = (await compileGraph(chain("route"), host).invoke(
      emptyRunState("TASK"),
    )) as RunState;

    expect(out.errors.primary).toBe("primary broke on attempt 2");
    expect(out.outputs.primary).toBeUndefined();
    expect(spawned).toContain("rescue");
    expect(spawned).not.toContain("report");
  });

  /** The default, unchanged: without the setting the run still ends. */
  it("ends the run when the node is left on stop", async () => {
    const { host, spawned } = makeHost({ primary: 99 });
    await expect(
      compileGraph(chain("stop"), host).invoke(emptyRunState("TASK")),
    ).rejects.toThrow("primary broke on attempt 2");
    expect(spawned).not.toContain("rescue");
  });

  it("uses up its attempts before giving up", async () => {
    const { host, spawned } = makeHost({ primary: 99 });
    await compileGraph(chain("route", 3), host).invoke(emptyRunState("TASK"));
    expect(spawned.filter((id) => id === "primary")).toHaveLength(3);
  });

  it("records every failed attempt in the run history", async () => {
    const { host, finished } = makeHost({ primary: 99 });
    await compileGraph(chain("route", 2), host).invoke(emptyRunState("TASK"));
    expect(finished.filter((entry) => entry.status === "failed")).toHaveLength(2);
  });

  it("takes the normal edge when a later attempt gets through", async () => {
    const { host, spawned } = makeHost({ primary: 1 });
    const out = (await compileGraph(chain("route", 2), host).invoke(
      emptyRunState("TASK"),
    )) as RunState;

    expect(out.outputs.primary).toBe("output of primary");
    expect(out.errors.primary).toBe("");
    expect(spawned).toContain("report");
    expect(spawned).not.toContain("rescue");
  });

  it("tells the fallback worker why it is standing in", async () => {
    const { host, prompts } = makeHost({ primary: 99 });
    await compileGraph(chain("route"), host).invoke(emptyRunState("TASK"));
    expect(prompts.rescue).toBe("After: primary broke on attempt 2");
  });

  it("says in the log that the run carries on", async () => {
    const { host, logs } = makeHost({ primary: 99 });
    await compileGraph(chain("route"), host).invoke(emptyRunState("TASK"));
    expect(logs.join("\n")).toContain("gave up after 2 attempts");
  });

  /**
   * The state is merged, so an error stays until something overwrites it. A
   * node that comes round again and succeeds has to clear its own entry, or a
   * `failed` edge keeps firing for the rest of the run on the strength of one
   * bad lap — and a cycle would never leave.
   */
  it("clears its error when a later visit succeeds", async () => {
    const graph = graphSchema.parse({
      id: "retry-loop",
      name: "Retry loop",
      nodes: [
        {
          id: "primary",
          label: "Primary",
          prompt: "Do: {{input}}",
          maxAttempts: 1,
          maxVisits: 2,
          onError: "route",
        },
        { id: "rescue", label: "Rescue", prompt: "Fix it", maxAttempts: 1 },
        { id: "report", label: "Report", prompt: "Got: {{primary}}", maxAttempts: 1 },
      ],
      edges: [
        { from: START_NODE, to: "primary" },
        { from: "primary", to: "rescue", when: when("failed") },
        { from: "primary", to: "report" },
        { from: "rescue", to: "primary" },
        { from: "report", to: END_NODE },
      ],
    });
    // Only the first visit fails, so the second lap must leave the loop.
    const { host, spawned } = makeHost({ primary: 1 });
    const out = (await compileGraph(graph, host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    })) as RunState;

    expect(out.errors.primary).toBe("");
    expect(out.outputs.primary).toBe("output of primary");
    expect(spawned).toEqual(["primary", "rescue", "primary", "report"]);
  });

  it("works for a dialogue node too, which gets no retry", async () => {
    const graph = graphSchema.parse({
      id: "dialog-failure",
      name: "Dialogue failure",
      nodes: [
        {
          id: "interview",
          label: "Interview",
          kind: "dialog",
          prompt: "Ask about {{input}}",
          onError: "route",
        },
        { id: "rescue", label: "Rescue", prompt: "After: {{interview.error}}" },
      ],
      edges: [
        { from: START_NODE, to: "interview" },
        { from: "interview", to: "rescue", when: when("failed") },
        { from: "rescue", to: END_NODE },
      ],
    });
    // An answer without the contract's JSON block fails the node on its one
    // and only attempt.
    const { host, spawned } = makeHost();
    const out = (await compileGraph(graph, {
      ...host,
      async awaitThread() {
        return "just talking, no JSON anywhere";
      },
    }).invoke(emptyRunState("TASK"))) as RunState;

    expect(out.errors.interview).not.toBe("");
    expect(spawned).toContain("rescue");
  });
});

describe("the fallback-chain template", () => {
  it("runs the other route when the direct one gives up", async () => {
    const { host, spawned } = makeHost({ primary: 99 });
    await compileGraph(templateById("fallback-chain")!, host).invoke(
      emptyRunState("TASK"),
    );
    expect(spawned).toContain("fallback");
    expect(spawned).not.toContain("give_up");
  });

  it("reaches the written give-up only when both routes are out", async () => {
    const { host, spawned } = makeHost({ primary: 99, fallback: 99 });
    await compileGraph(templateById("fallback-chain")!, host).invoke(
      emptyRunState("TASK"),
    );
    expect(spawned).toContain("give_up");
  });

  it("goes straight to the report when the direct route works", async () => {
    const { host, spawned } = makeHost();
    await compileGraph(templateById("fallback-chain")!, host).invoke(
      emptyRunState("TASK"),
    );
    expect(spawned).toEqual(["primary", "report"]);
  });
});

/* ── what the reader is told ───────────────────────────────────────────── */

describe("how a failure edge reads", () => {
  const fallback = templateById("fallback-chain")!;

  it("says on failure on the arrow leaving the node that failed", () => {
    const edge = fallback.edges.find(
      (entry) => entry.from === "primary" && entry.to === "fallback",
    )!;
    // The template gives this one a label of its own, so the generated text is
    // asked for directly; `edgeLabel` would rightly prefer the author's.
    expect(conditionLabel({ ...edge, label: "" })).toBe("on failure");
    expect(edgeLabel(edge)).toBe("gave up");
  });

  it("names the node when the condition is about a different one", () => {
    const edge = { from: "report", to: "rescue", when: when("failed", "build"), label: "", fanOutOver: "" };
    expect(conditionLabel(edge)).toBe("build failed");
  });

  it("prints the outcome condition without a comparison value", () => {
    const text = describeGraph(fallback, []);
    expect(text).toContain("primary → fallback  if primary failed");
    // The shape the other conditions use would name the node's text here,
    // which is not what is being asked about.
    expect(text).not.toContain("text(primary) failed");
  });

  it("says which nodes route their failure", () => {
    const text = describeGraph(fallback, []);
    expect(text).toContain("[agent] primary — Direct route  max 3×  routes its failure");
    expect(text).not.toContain("[agent] report — Report  max 3×  routes its failure");
  });
});
