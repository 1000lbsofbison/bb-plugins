// Structured joins: when several incoming edges may be waited for, and when
// waiting would deadlock the run.
//
// The negative cases carry the weight here. A join declared where the branches
// are alternatives — a back edge, a conditional split — makes the engine wait
// for something that never arrives, and the run hangs instead of failing
// loudly. Each `toBeNull()` below is one such shape.
import { describe, expect, it } from "vitest";
import {
  END_NODE,
  START_NODE,
  emptyRunState,
  graphSchema,
  joinSources,
  parseDialogTurn,
  validateGraph,
  DIALOG_CONTRACT,
  type Graph,
} from "../lib/graph";
import { compileGraph, type RuntimeHost } from "../lib/runtime";
import { TEMPLATES, templateById } from "../lib/templates";

const node = (id: string) => ({ id, label: id.toUpperCase(), prompt: `${id}: {{input}}` });

const build = (nodes: string[], edges: unknown[]): Graph =>
  graphSchema.parse({
    id: "probe",
    name: "Probe",
    nodes: nodes.map(node),
    edges,
  });

/** Records which node ran, in order. */
function fakeHost() {
  const spawned: string[] = [];
  const host: RuntimeHost = {
    async spawn({ nodeId }) {
      spawned.push(nodeId);
      return `thr_${nodeId}_${spawned.length}`;
    },
    async awaitThread(threadId) {
      return `output of ${threadId.split("_")[1]}`;
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
    log() {},
  };
  return { host, spawned };
}

/** split → short, and split → long1 → long2; both end at join. */
const lopsided = (): Graph =>
  build(["split", "short", "long1", "long2", "join"], [
    { from: START_NODE, to: "split" },
    { from: "split", to: "short" },
    { from: "split", to: "long1" },
    { from: "long1", to: "long2" },
    { from: "short", to: "join" },
    { from: "long2", to: "join" },
    { from: "join", to: END_NODE },
  ]);

describe("joinSources", () => {
  it("recognises branches of equal length", () => {
    const graph = build(["split", "a", "b", "join"], [
      { from: START_NODE, to: "split" },
      { from: "split", to: "a" },
      { from: "split", to: "b" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
      { from: "join", to: END_NODE },
    ]);
    expect(joinSources(graph, "join")).toEqual(["a", "b"]);
  });

  it("recognises branches of unequal length", () => {
    expect(joinSources(lopsided(), "join")).toEqual(["short", "long2"]);
  });

  it("recognises the merge of the shipped fan-out template", () => {
    const graph = templateById("parallel-sectioning")!;
    expect(joinSources(graph, "merge")).toEqual(["a", "b", "c"]);
  });

  it("is null for a single incoming edge", () => {
    expect(joinSources(lopsided(), "long2")).toBeNull();
  });

  /**
   * The case that made this function necessary. `worker` is entered from the
   * plan and from the critic's back edge; exactly one of them delivers per
   * pass. Waiting for both would hang `harness-arc` on its first step.
   */
  it("is null where a back edge only looks like a second branch", () => {
    const graph = templateById("harness-arc")!;
    expect(joinSources(graph, "worker")).toBeNull();
  });

  it("is null when the branches start at different fan-outs", () => {
    const graph = build(["s1", "s2", "a", "b", "x", "y", "join"], [
      { from: START_NODE, to: "s1" },
      { from: "s1", to: "a" },
      { from: "s1", to: "b" },
      { from: "a", to: "s2" },
      { from: "s2", to: "x" },
      { from: "s2", to: "y" },
      { from: "x", to: "join" },
      { from: "b", to: "join" },
      { from: "y", to: END_NODE },
      { from: "join", to: END_NODE },
    ]);
    expect(joinSources(graph, "join")).toBeNull();
  });

  it("is null when one branch of the fan-out ends elsewhere", () => {
    const graph = build(["split", "a", "b", "c", "join"], [
      { from: START_NODE, to: "split" },
      { from: "split", to: "a" },
      { from: "split", to: "b" },
      { from: "split", to: "c" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
      { from: "c", to: END_NODE },
      { from: "join", to: END_NODE },
    ]);
    expect(joinSources(graph, "join")).toBeNull();
  });

  it("is null when a conditional edge could skip a branch", () => {
    const graph = build(["split", "a", "b", "join"], [
      { from: START_NODE, to: "split" },
      { from: "split", to: "a" },
      { from: "split", to: "b" },
      { from: "a", to: "join" },
      {
        from: "b",
        to: "join",
        when: { source: "output", key: "b", op: "contains", value: "JA" },
      },
      { from: "join", to: END_NODE },
    ]);
    expect(joinSources(graph, "join")).toBeNull();
  });

  /**
   * Inside a cycle the join would run again, and a join edge no longer passes
   * through the visit check. Refused rather than silently unbounded.
   */
  it("is null when the fan-out sits in a cycle", () => {
    const graph = build(["split", "a", "b", "join", "again"], [
      { from: START_NODE, to: "split" },
      { from: "split", to: "a" },
      { from: "split", to: "b" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
      { from: "join", to: "again" },
      { from: "again", to: "split" },
    ]);
    expect(joinSources(graph, "join")).toBeNull();
  });
});

describe("join edges at run time", () => {
  /**
   * Measured before the fix: the join ran twice — "split, long1, short, join,
   * long2, join" — so its first run read a state `long2` had not written yet.
   */
  it("runs a join once, after the longer branch", async () => {
    const { host, spawned } = fakeHost();
    await compileGraph(lopsided(), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(spawned.filter((id) => id === "join")).toHaveLength(1);
    expect(spawned.indexOf("join")).toBeGreaterThan(spawned.indexOf("long2"));
  });

  it("still enters a node that has a back edge, without waiting for it", async () => {
    const { host, spawned } = fakeHost();
    const graph = build(["plan", "worker", "critic"], [
      { from: START_NODE, to: "plan" },
      { from: "plan", to: "worker" },
      { from: "worker", to: "critic" },
      {
        from: "critic",
        to: "worker",
        when: { source: "output", key: "critic", op: "contains", value: "NEVER" },
      },
      { from: "critic", to: END_NODE },
    ]);
    await compileGraph(graph, host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(spawned).toEqual(["plan", "worker", "critic"]);
  });
});

describe("warning for an unsynchronised merge", () => {
  const warnings = (graph: Graph) =>
    validateGraph(graph)
      .filter((problem) => problem.level === "warning")
      .map((problem) => problem.message);

  const hit = (graph: Graph) =>
    warnings(graph).filter((message) => /does not count as a join/.test(message));

  /**
   * A conditional edge on one branch keeps this out of `joinSources`, so no
   * join edge is wired — and the target really can run twice. Warned about
   * rather than left to be discovered in a run.
   */
  it("warns when a branch can be skipped", () => {
    const graph = build(["split", "a", "b", "join"], [
      { from: START_NODE, to: "split" },
      { from: "split", to: "a" },
      { from: "split", to: "b" },
      { from: "a", to: "join" },
      {
        from: "b",
        to: "join",
        when: { source: "output", key: "b", op: "contains", value: "JA" },
      },
      { from: "join", to: END_NODE },
    ]);
    expect(hit(graph)).toHaveLength(1);
    expect(hit(graph)[0]).toMatch(/JOIN/);
  });

  it("stays silent for a recognised join", () => {
    expect(hit(lopsided())).toEqual([]);
  });

  /** What lies beyond a join is entered once, not once per branch. */
  it("stays silent for a node behind a join", () => {
    const graph = build(["split", "a", "b", "join", "report"], [
      { from: START_NODE, to: "split" },
      { from: "split", to: "a" },
      { from: "split", to: "b" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
      { from: "join", to: "report" },
      { from: "report", to: END_NODE },
    ]);
    expect(hit(graph)).toEqual([]);
  });

  it("stays silent for every shipped template", () => {
    for (const id of TEMPLATES.map((entry) => entry.id)) {
      expect({ id, warnings: hit(templateById(id)!) }).toEqual({ id, warnings: [] });
    }
  });
});

/**
 * Edge labels follow one rule, and it carries meaning: an edge that routes on
 * an enum value is labelled with that value, in the capitals the model writes;
 * anything else gets a lowercase description. Mixing the two makes "otherwise"
 * sit next to "BUG" and read like an oversight — and worse, it hides the third
 * enum value, which is the one that edge actually catches.
 */
describe("edge labels name the value they route on", () => {
  const enumValueOf = (graph: Graph, edge: Graph["edges"][number]) => {
    if (!edge.when || edge.when.op !== "equals" || edge.when.source !== "field") {
      return null;
    }
    const [nodeId, fieldName] = edge.when.key.includes(".")
      ? edge.when.key.split(".")
      : [edge.from, edge.when.key];
    const field = graph.nodes
      .find((node) => node.id === nodeId)
      ?.fields.find((entry) => entry.name === fieldName);
    return field?.type === "enum" ? edge.when.value : null;
  };

  it("labels every enum-routed edge with its value", () => {
    const wrong: string[] = [];
    for (const graph of TEMPLATES) {
      for (const edge of graph.edges) {
        const value = enumValueOf(graph, edge);
        if (value && edge.label && edge.label !== value) {
          wrong.push(`${graph.id}: ${edge.from}→${edge.to} says "${edge.label}", routes on "${value}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The other half, and the one that took a correction: a label in capitals
   * does not have to sit on a *conditional* edge. `test → progress` is
   * unconditional and still says GREEN, because RED is routed away above it
   * and GREEN is the only value that can arrive — the same reasoning that put
   * QUESTION on the routing template's fallback.
   *
   * So the rule is not about the edge but about the word: capitals mean "this
   * is a value the field can hold". A label shouting something no field
   * declares is either a typo or a value that was renamed and left behind —
   * GRUEN against GREEN is exactly the kind of silent miss this project has
   * paid for before.
   */
  it("only shouts words that are actually enum values", () => {
    const unknown: string[] = [];
    for (const graph of TEMPLATES) {
      const values = new Set(
        graph.nodes.flatMap((node) =>
          node.fields.filter((f) => f.type === "enum").flatMap((f) => f.options),
        ),
      );
      for (const edge of graph.edges) {
        if (!edge.label || edge.label !== edge.label.toUpperCase()) continue;
        if (!values.has(edge.label)) {
          unknown.push(`${graph.id}: ${edge.from}→${edge.to} "${edge.label}"`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});

/**
 * The failure that ended a real run: a dialogue worker quoted itself inside
 * `question` with a plain `"`, the JSON string ended early, and the block did
 * not parse. A dialogue node cannot be retried — it uses `interrupt()`, and a
 * retry policy would read every question as a failure (`lib/runtime.ts`, the
 * `kind === "agent"` guard) — so a broken block ends the whole run instead of
 * costing one attempt. An hour and 43k tokens, spent on one character.
 */
describe("the dialogue contract and its sharp edge", () => {
  it("still fails on a straight quote inside the question", () => {
    const broken =
      'Reasoning above.\n\n```json\n{ "done": false, "question": "Keep the rule "as is" or drop it?" }\n```';
    expect(() => parseDialogTurn(broken)).toThrow(/JSON block is invalid/);
  });

  it("accepts the same question quoted typographically", () => {
    const fine =
      'Reasoning above.\n\n```json\n{ "done": false, "question": "Keep the rule ‚as is‘ or drop it?" }\n```';
    expect(parseDialogTurn(fine).question).toMatch(/as is/);
  });

  /**
   * The contract is the only place the worker reads, so the rule has to be in
   * it — not in a comment next to the parser.
   */
  it("tells the worker about it in the contract itself", () => {
    expect(DIALOG_CONTRACT).toMatch(/straight quotation mark/);
  });
});
