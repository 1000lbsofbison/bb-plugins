// Roadmap #17: an edge whose target is read from a field.
//
// This is the first edge in the model whose destination is not visible in the
// graph, so the tests carry more than usual. Two forms with deliberately
// different guarantees: an enum of node ids, where the canvas can draw the
// candidates and the reachability check can count them, and a free string,
// where neither can — and where the warning is the only thing standing between
// "open swarm" and "silent hole".
import { describe, expect, it } from "vitest";
import {
  END_NODE,
  START_NODE,
  edgeTargets,
  emptyRunState,
  graphSchema,
  handoffTargets,
  reachableFromStart,
  resolveHandoff,
  routeAll,
  routeFrom,
  validateGraph,
  type Graph,
  type RunState,
} from "../lib/graph";
import { layoutGraph } from "../lib/layout";
import { describeGraph } from "../lib/describe";
import { compileGraph, type RuntimeHost } from "../lib/runtime";
import { templateById } from "../lib/templates";

/**
 * Three specialists and a way out. `next` is the enum form; swap its type for
 * `string` and the same graph becomes the open swarm.
 */
const team = (options: string[] = ["write", "review"], type = "enum"): Graph =>
  graphSchema.parse({
    id: "team",
    name: "Team",
    nodes: [
      {
        id: "research",
        label: "Research",
        prompt: "Research {{input}}",
        maxVisits: 3,
        fields: [
          { name: "status", type: "enum", options: ["HANDOFF", "DONE"] },
          { name: "next", type, options: type === "enum" ? options : [] },
        ],
      },
      { id: "write", label: "Write", prompt: "Write", maxVisits: 3 },
      { id: "review", label: "Review", prompt: "Review", maxVisits: 3 },
      { id: "finish", label: "Finish", prompt: "Finish" },
    ],
    edges: [
      { from: START_NODE, to: "research" },
      {
        from: "research",
        to: "finish",
        when: { source: "field", key: "research.status", op: "equals", value: "HANDOFF" },
        handoffFrom: "research.next",
        label: "HANDOFF",
      },
      { from: "research", to: "finish", label: "DONE" },
      { from: "write", to: "finish" },
      { from: "review", to: "finish" },
      { from: "finish", to: END_NODE },
    ],
  });

const handoffEdge = (graph: Graph) =>
  graph.edges.find((edge) => edge.handoffFrom !== "")!;

const said = (fields: Record<string, string>): RunState => ({
  ...emptyRunState("TASK"),
  fields: { research: fields },
  visits: { research: 1 },
});

/* ── which targets are declared ────────────────────────────────────────── */

describe("the declared successors of a handoff", () => {
  it("are the options of an enum field", () => {
    const graph = team();
    expect(handoffTargets(graph, handoffEdge(graph))).toEqual(["write", "review"]);
  });

  /**
   * Not an oversight: a free-text handoff may go anywhere, and answering "any
   * node" here would have the canvas draw an arrow between every pair.
   */
  it("are unknown for a free-text field", () => {
    const graph = team([], "string");
    expect(handoffTargets(graph, handoffEdge(graph))).toEqual([]);
  });

  it("leave out an option that names no node", () => {
    const graph = team(["write", "nobody"]);
    expect(handoffTargets(graph, handoffEdge(graph))).toEqual(["write"]);
  });

  it("join the edge's own target in the full target list", () => {
    const graph = team();
    expect(edgeTargets(graph, handoffEdge(graph))).toEqual([
      "finish",
      "write",
      "review",
    ]);
  });
});

/* ── where it actually goes ────────────────────────────────────────────── */

describe("resolving a handoff", () => {
  it("goes where the field says", () => {
    const graph = team();
    expect(resolveHandoff(graph, handoffEdge(graph), said({ next: "review" }))).toEqual({
      wanted: "review",
      used: "review",
      resolved: true,
    });
  });

  /**
   * The worker is a language model asked for a node id, so it will sometimes
   * answer with a label or a sentence. Falling back keeps the run going; the
   * runtime logs it, because a swarm that quietly always takes the fallback
   * looks exactly like a swarm that works.
   */
  it("falls back to the edge's own target when the name is unknown", () => {
    const graph = team();
    expect(
      resolveHandoff(graph, handoffEdge(graph), said({ next: "the writer" })),
    ).toEqual({ wanted: "the writer", used: "finish", resolved: false });
  });

  it("falls back when the field said nothing at all", () => {
    const graph = team();
    expect(resolveHandoff(graph, handoffEdge(graph), emptyRunState("T"))).toEqual({
      wanted: "",
      used: "finish",
      resolved: false,
    });
  });
});

describe("routing over a handoff", () => {
  it("routes to the named node and reports the choice", () => {
    const state = said({ status: "HANDOFF", next: "write" });
    const routed = routeFrom(team(), "research", state);
    expect(routed.next).toBe("write");
    expect(routed.handoffs).toEqual([
      { wanted: "write", used: "write", resolved: true },
    ]);
  });

  /** The condition still decides whether the edge is taken at all. */
  it("ignores the field when the edge's condition does not hold", () => {
    const state = said({ status: "DONE", next: "write" });
    const routed = routeFrom(team(), "research", state);
    expect(routed.next).toBe("finish");
    expect(routed.handoffs).toEqual([]);
  });

  it("passes the edge over when the named node is out of visits", () => {
    const state: RunState = {
      ...said({ status: "HANDOFF", next: "write" }),
      visits: { research: 1, write: 3 },
    };
    const routed = routeFrom(team(), "research", state);
    // Falls through to the next edge, exactly as a fixed target would.
    expect(routed.next).toBe("finish");
    expect(routed.skipped).toEqual([{ to: "write", label: "Write", maxVisits: 3 }]);
  });

  it("works the same under every-matching routing", () => {
    const graph = graphSchema.parse({
      ...team(),
      nodes: team().nodes.map((node) =>
        node.id === "research" ? { ...node, routing: "every" } : node,
      ),
    });
    const routed = routeAll(graph, "research", said({ status: "HANDOFF", next: "review" }));
    expect(routed.next).toContain("review");
    expect(routed.handoffs).toEqual([
      { wanted: "review", used: "review", resolved: true },
    ]);
  });
});

/* ── what the graph can still promise ──────────────────────────────────── */

describe("reachability", () => {
  /** The payoff of the enum form: the check stays whole. */
  it("counts a node that is only ever reached by a declared handoff", () => {
    const graph = team();
    expect([...reachableFromStart(graph)].sort()).toEqual([
      "finish",
      "research",
      "review",
      "write",
    ]);
  });

  /**
   * The price of the free-text form, written down rather than glossed over.
   * `write` and `review` are genuinely unreachable as far as anything can
   * tell, which is why that form is a warning and the enum is recommended.
   */
  it("cannot see where a free-text handoff goes", () => {
    const graph = team([], "string");
    expect([...reachableFromStart(graph)].sort()).toEqual(["finish", "research"]);
  });
});

/* ── the validator ─────────────────────────────────────────────────────── */

const problems = (graph: Graph, level?: "error" | "warning") =>
  validateGraph(graph)
    .filter((problem) => level === undefined || problem.level === level)
    .map((problem) => problem.message);

/** The team graph with the handoff edge patched. */
const patched = (patch: Record<string, unknown>, nodes?: unknown): Graph =>
  graphSchema.parse({
    ...team(),
    ...(nodes ? { nodes } : {}),
    edges: team().edges.map((edge) =>
      edge.handoffFrom !== "" ? { ...edge, ...patch } : edge,
    ),
  });

describe("validation of a handoff", () => {
  it("passes the recommended enum form without a word", () => {
    expect(problems(team())).toEqual([]);
  });

  it("refuses a field nobody declared", () => {
    expect(problems(patched({ handoffFrom: "research.whoever" }), "error")).toContain(
      'Edge research → finish takes its target from "research.whoever", but that field is not declared.',
    );
  });

  it("refuses a field that is neither a choice nor a text", () => {
    const graph = graphSchema.parse({
      ...team(),
      nodes: team().nodes.map((node) =>
        node.id === "research"
          ? {
              ...node,
              fields: [
                { name: "status", type: "enum", options: ["HANDOFF", "DONE"] },
                { name: "next", type: "list", options: [] },
              ],
            }
          : node,
      ),
    });
    expect(problems(graph, "error")).toContain(
      'Edge research → finish takes its target from "next", but that field is of type "list"; a target comes from a choice or a text.',
    );
  });

  /** The enum form promises its options are the successors. This is that. */
  it("refuses an option that names no node", () => {
    expect(problems(team(["write", "nobody"]), "error")).toContain(
      'Edge research → finish takes its target from "next", but "nobody" names no node in this graph.',
    );
  });

  it("refuses a choice with no options at all", () => {
    expect(problems(team([]), "error")).toContain(
      'Edge research → finish takes its target from "next", but that choice declares no options; there is nothing it could hand off to.',
    );
  });

  it("warns about the free-text form rather than refusing it", () => {
    const graph = team([], "string");
    expect(problems(graph, "error")).toEqual([]);
    expect(problems(graph, "warning")).toContain(
      'Edge research → finish takes its target from the free text "next"; the canvas cannot draw where it goes and the check for unreachable nodes cannot see it. An enum of node ids keeps both.',
    );
  });

  it("refuses an edge that both fans out and hands off", () => {
    expect(
      problems(patched({ fanOutOver: "research.next", when: null }), "error"),
    ).toContain(
      "Edge research → finish both fans out and hands off; an edge does one or the other.",
    );
  });

  /**
   * A node whose edges are all unconditional takes all of them at once. The
   * runtime wires that case without consulting the field, so a handoff there
   * would be ignored rather than wrong — the silent kind.
   */
  it("refuses a handoff on a node that branches to everything", () => {
    const graph = graphSchema.parse({
      ...team(),
      edges: [
        { from: START_NODE, to: "research" },
        { from: "research", to: "write", handoffFrom: "research.next" },
        { from: "research", to: "review" },
        { from: "write", to: "finish" },
        { from: "review", to: "finish" },
        { from: "finish", to: END_NODE },
      ],
    });
    expect(problems(graph, "error")).toContain(
      'Edge research → write hands off, but "research" branches to all its targets at once; a handoff chooses one.',
    );
  });
});

/* ── what the reader sees ──────────────────────────────────────────────── */

describe("the drawing", () => {
  it("draws one arrow per declared candidate, marked as possible", () => {
    const drawn = layoutGraph(team()).edges.filter((edge) => edge.candidate);
    expect(drawn.map((edge) => `${edge.from}→${edge.to}`).sort()).toEqual([
      "research→review",
      "research→write",
    ]);
  });

  /** Nothing to draw, and drawing nothing is the honest answer. */
  it("draws no candidates for a free-text handoff", () => {
    expect(layoutGraph(team([], "string")).edges.some((edge) => edge.candidate)).toBe(
      false,
    );
  });

  it("keeps the author's own arrow solid and says it is the fallback", () => {
    // The team graph labels it "HANDOFF"; an unlabelled one gets the wording.
    const graph = graphSchema.parse({
      ...team(),
      edges: team().edges.map((edge) =>
        edge.handoffFrom !== "" ? { ...edge, label: "" } : edge,
      ),
    });
    const drawn = layoutGraph(graph).edges.find(
      (edge) => edge.from === "research" && edge.to === "finish" && !edge.candidate,
    )!;
    expect(drawn.label).toBe("if no successor is named");
  });

  it("says in the text form where the target comes from", () => {
    expect(describeGraph(team(), [])).toContain(
      "research → finish  target from research.next, else finish",
    );
  });
});

/* ── the runtime ───────────────────────────────────────────────────────── */

/** Answers each node with a scripted reply; records what ran and was logged. */
function makeHost(replies: Record<string, string>) {
  const spawned: string[] = [];
  const logs: string[] = [];
  const host: RuntimeHost = {
    async spawn({ nodeId }) {
      spawned.push(nodeId);
      return `thr_${nodeId}_${spawned.length}`;
    },
    async awaitThread(threadId) {
      const nodeId = threadId.split("_").slice(1, -1).join("_");
      return replies[nodeId] ?? `output of ${nodeId}`;
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
    async wait() {},
  };
  return { host, spawned, logs };
}

const answer = (fields: Record<string, string>) =>
  `Done.\n\n\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``;

describe("a run over a handoff", () => {
  it("goes to the node the worker named", async () => {
    const { host, spawned } = makeHost({
      research: answer({ status: "HANDOFF", next: "review" }),
    });
    await compileGraph(team(), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(spawned).toEqual(["research", "review", "finish"]);
  });

  /**
   * The free-text form, because this is the case it exists for. In the enum
   * form the value never gets this far: `parseFields` refuses anything outside
   * the options, so an off-list answer is a failed attempt at the node rather
   * than a bad route — which is the next test, and the better failure of the
   * two.
   */
  it("takes the fallback when the worker named something unknown", async () => {
    const { host, spawned, logs } = makeHost({
      research: answer({ status: "HANDOFF", next: "the reviewer" }),
    });
    await compileGraph(team([], "string"), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(spawned).toEqual(["research", "finish"]);
    expect(logs.join("\n")).toContain(
      '"Research" named "the reviewer", which is no node in this graph; the run carries on to "Finish".',
    );
  });

  /**
   * The free-text form's real test. Nothing in the graph routes to `write`, so
   * LangGraph would refuse to compile at all unless the runtime declares every
   * node a possible target of the handing-off node — which is what the price
   * this form pays actually consists of.
   */
  it("reaches a node nothing else points at, in the free-text form", async () => {
    const { host, spawned } = makeHost({
      research: answer({ status: "HANDOFF", next: "write" }),
    });
    await compileGraph(team([], "string"), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(spawned).toEqual(["research", "write", "finish"]);
  });

  it("never lets an off-list name out of an enum node in the first place", async () => {
    const { host } = makeHost({
      research: answer({ status: "HANDOFF", next: "the reviewer" }),
    });
    await expect(
      compileGraph(team(), host).invoke(emptyRunState("TASK"), { recursionLimit: 50 }),
    ).rejects.toThrow(/Field "next" is "the reviewer"/);
  });

  /**
   * The one routing decision a reader cannot reconstruct from the drawing, so
   * it is the one that has to be in the log even when it worked.
   */
  it("says in the log where it handed off", async () => {
    const { host, logs } = makeHost({
      research: answer({ status: "HANDOFF", next: "write" }),
    });
    await compileGraph(team(), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(logs.join("\n")).toContain('"Research" handed off to "Write".');
  });

  it("says nothing of the sort when the edge was not taken", async () => {
    const { host, logs } = makeHost({
      research: answer({ status: "DONE", next: "write" }),
    });
    await compileGraph(team(), host).invoke(emptyRunState("TASK"), {
      recursionLimit: 50,
    });
    expect(logs.join("\n")).not.toContain("handed off");
  });
});

describe("the swarm template", () => {
  it("passes the task along until somebody says it is done", async () => {
    const { host, spawned } = makeHost({
      research: answer({ status: "HANDOFF", next: "write" }),
      write: answer({ status: "HANDOFF", next: "review" }),
      review: answer({ status: "DONE", next: "write" }),
    });
    await compileGraph(templateById("swarm")!, host).invoke(emptyRunState("TASK"), {
      recursionLimit: 60,
    });
    expect(spawned).toEqual(["research", "write", "review", "finish"]);
  });

  it("hands over directly when the first specialist is already done", async () => {
    const { host, spawned } = makeHost({
      research: answer({ status: "DONE", next: "write" }),
    });
    await compileGraph(templateById("swarm")!, host).invoke(emptyRunState("TASK"), {
      recursionLimit: 60,
    });
    expect(spawned).toEqual(["research", "finish"]);
  });
});
