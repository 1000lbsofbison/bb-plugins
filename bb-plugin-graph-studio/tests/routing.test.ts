// The inclusive or: a node set to `every` takes every edge whose condition
// holds, instead of the first one.
//
// The negative cases are what this rests on. `every` is opt-in precisely so
// that no existing graph changes behaviour, so the first test below — a node
// left on the default still picking exactly one target — is the one that would
// catch a regression worth the name.
import { describe, expect, it } from "vitest";
import {
  END_NODE,
  START_NODE,
  emptyRunState,
  graphSchema,
  routeAll,
  validateGraph,
  type Graph,
  type RunState,
} from "../lib/graph";
import { compileGraph, type RuntimeHost } from "../lib/runtime";
import { TEMPLATES, templateById } from "../lib/templates";

const contains = (key: string, value: string) => ({
  source: "output" as const,
  key,
  op: "contains" as const,
  value,
});

/** `pick` opens three branches whose conditions may all hold at once. */
const split = (routing: "first" | "every"): Graph =>
  graphSchema.parse({
    id: "split",
    name: "Split",
    nodes: [
      { id: "pick", label: "Pick", prompt: "Pick: {{input}}", routing },
      { id: "red", label: "Red", prompt: "Red" },
      { id: "blue", label: "Blue", prompt: "Blue" },
      { id: "green", label: "Green", prompt: "Green" },
    ],
    edges: [
      { from: START_NODE, to: "pick" },
      { from: "pick", to: "red", when: contains("pick", "RED") },
      { from: "pick", to: "blue", when: contains("pick", "BLUE") },
      { from: "pick", to: "green", when: contains("pick", "GREEN") },
    ],
  });

const said = (text: string): RunState => ({
  ...emptyRunState("TASK"),
  outputs: { pick: text },
});

function fakeHost(reply: string) {
  const spawned: string[] = [];
  const logs: string[] = [];
  const host: RuntimeHost = {
    async spawn({ nodeId }) {
      spawned.push(nodeId);
      return `thr_${nodeId}_${spawned.length}`;
    },
    async awaitThread(threadId) {
      return threadId.startsWith("thr_pick") ? reply : "done";
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
  return { host, spawned, logs };
}

describe("routeAll", () => {
  /** The guarantee that makes `every` safe to add: nothing else moves. */
  it("takes only the first match when the node is left on the default", () => {
    const { next } = routeAll(split("first"), "pick", said("RED and BLUE"));
    expect(next).toEqual(["red"]);
  });

  it("takes every matching branch under `every`", () => {
    const { next } = routeAll(split("every"), "pick", said("RED and BLUE"));
    expect(next).toEqual(["red", "blue"]);
  });

  it("leaves out a branch whose condition does not hold", () => {
    const { next } = routeAll(split("every"), "pick", said("only BLUE"));
    expect(next).toEqual(["blue"]);
  });

  it("returns nothing when no condition holds", () => {
    expect(routeAll(split("every"), "pick", said("none of them")).next).toEqual([]);
  });

  it("drops a branch that is out of visits and says which", () => {
    const state = { ...said("RED and BLUE"), visits: { red: 3 } };
    const { next, skipped } = routeAll(split("every"), "pick", state);
    expect(next).toEqual(["blue"]);
    expect(skipped.map((entry) => entry.to)).toEqual(["red"]);
  });
});

describe("`every` at run time", () => {
  it("runs both chosen branches and leaves the third alone", async () => {
    const { host, spawned } = fakeHost("RED and BLUE");
    await compileGraph(split("every"), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(spawned).toContain("red");
    expect(spawned).toContain("blue");
    expect(spawned).not.toContain("green");
  });

  it("ends the run when no branch was chosen, and says so", async () => {
    const { host, spawned, logs } = fakeHost("none of them");
    await compileGraph(split("every"), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(spawned).toEqual(["pick"]);
    expect(logs.join()).toMatch(/chose no branch/);
  });
});

describe("validation of the routing mode", () => {
  const messages = (graph: Graph) => validateGraph(graph).map((problem) => problem.message);

  it("warns when `every` has nothing to choose between", () => {
    const graph = graphSchema.parse({
      id: "lonely",
      name: "Lonely",
      nodes: [
        { id: "a", label: "A", prompt: "A", routing: "every" },
        { id: "b", label: "B", prompt: "B" },
      ],
      edges: [
        { from: START_NODE, to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: END_NODE },
      ],
    });
    expect(messages(graph).join()).toMatch(/has no effect/);
  });

  /**
   * Mixing a conditional with several unconditional edges is an error under
   * `first` — it hides whether the author meant "all" or "one". Under `every`
   * it is the point: the unconditional branch always runs, the others when
   * their condition holds.
   */
  it("accepts under `every` the edge mix it rejects under `first`", () => {
    const mixed = (routing: "first" | "every") =>
      graphSchema.parse({
        id: "mixed",
        name: "Mixed",
        nodes: [
          { id: "a", label: "A", prompt: "A", routing },
          { id: "x", label: "X", prompt: "X" },
          { id: "y", label: "Y", prompt: "Y" },
          { id: "z", label: "Z", prompt: "Z" },
        ],
        edges: [
          { from: START_NODE, to: "a" },
          { from: "a", to: "x", when: contains("a", "JA") },
          { from: "a", to: "y" },
          { from: "a", to: "z" },
          { from: "x", to: END_NODE },
          { from: "y", to: END_NODE },
          { from: "z", to: END_NODE },
        ],
      });
    expect(messages(mixed("first")).join()).toMatch(/mixes conditional/);
    expect(messages(mixed("every")).join()).not.toMatch(/mixes conditional/);
  });

  /**
   * `every` is opt-in, and the opting-in has to stay deliberate: exactly one
   * shipped node uses it, and it is the one whose whole point is the inclusive
   * or. A second entry here means someone changed a graph's behaviour without
   * meaning to.
   */
  it("uses `every` in exactly one shipped node", () => {
    const inclusive = TEMPLATES.flatMap((template) =>
      template.nodes
        .filter((node) => node.routing === "every")
        .map((node) => `${template.id}.${node.id}`),
    );
    expect(inclusive).toEqual(["multi-choice.triage"]);
  });
});

describe("deferred-choice routing", () => {
  /**
   * An approval node yields the answer as typed, so these edges match text —
   * the very thing declared fields exist to avoid. Anchoring to the first word
   * is what keeps that safe, and these are the cases that prove it.
   */
  const route = (answer: string) => {
    const graph = templateById("deferred-choice")!;
    return routeAll(graph, "decide", {
      ...emptyRunState("TASK"),
      outputs: { decide: answer },
    }).next;
  };

  it("acts when the answer starts with ACT", () => {
    expect(route("ACT — let's get it done")).toEqual(["act"]);
  });

  it("ends when the answer starts with DROP", () => {
    expect(route("DROP, not worth it")).toEqual([]);
  });

  it("does not act on an answer that merely mentions acting", () => {
    expect(route("I would not act on this yet")).toEqual(["record"]);
  });

  it("does not act on a refusal that contains the word", () => {
    expect(route("no ACT please")).toEqual(["record"]);
  });

  it("falls back to writing it down when the answer is unparseable", () => {
    expect(route("hmm, let me think about it")).toEqual(["record"]);
  });
});
