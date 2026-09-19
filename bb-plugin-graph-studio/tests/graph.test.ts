import { describe, expect, it } from "vitest";
import {
  END_NODE,
  START_NODE,
  composeDialogPrompt,
  composeNodePrompt,
  emptyRunState,
  evaluateCondition,
  fanOutProgress,
  graphSchema,
  isFanOut,
  mergeCollected,
  nodeExecution,
  reachableNodeIds,
  spawnExecution,
  renderPrompt,
  resolveNext,
  routeFrom,
  validateGraph,
  type Graph,
} from "../lib/graph";
import {
  LAYER_GAP_LABELLED,
  LAYER_GAP_TIGHT,
  layoutGraph,
} from "../lib/layout";
import { TEMPLATES, templateById } from "../lib/templates";

const linear = (): Graph =>
  graphSchema.parse({
    id: "linear",
    name: "Linear",
    nodes: [
      { id: "a", label: "A", prompt: "a" },
      { id: "b", label: "B", prompt: "b" },
    ],
    edges: [
      { from: START_NODE, to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: END_NODE },
    ],
  });

describe("validation", () => {
  it("accepts a linear graph", () => {
    expect(validateGraph(linear()).filter((p) => p.level === "error")).toEqual([]);
  });

  it("rejects a graph with no entry", () => {
    const graph = linear();
    graph.edges = graph.edges.filter((edge) => edge.from !== START_NODE);
    expect(
      validateGraph(graph).some((p) => p.level === "error" && /No entry/.test(p.message)),
    ).toBe(true);
  });

  it("rejects more than one entry", () => {
    const graph = linear();
    graph.edges.push({ from: START_NODE, to: "b", when: null, label: "" });
    expect(
      validateGraph(graph).some((p) => p.level === "error" && /one entry/.test(p.message)),
    ).toBe(true);
  });

  it("treats several unconditional edges as a fan-out, not an error", () => {
    const graph = graphSchema.parse({
      id: "fan",
      name: "Fan",
      nodes: [
        { id: "s", label: "S", prompt: "s" },
        { id: "x", label: "X", prompt: "x" },
        { id: "y", label: "Y", prompt: "y" },
      ],
      edges: [
        { from: START_NODE, to: "s" },
        { from: "s", to: "x" },
        { from: "s", to: "y" },
        { from: "x", to: END_NODE },
        { from: "y", to: END_NODE },
      ],
    });
    expect(validateGraph(graph).filter((p) => p.level === "error")).toEqual([]);
    expect(isFanOut(graph, "s")).toBe(true);
  });

  it("flags an ambiguous mix of conditional and unconditional edges", () => {
    const graph = graphSchema.parse({
      id: "mix",
      name: "Mix",
      nodes: [
        { id: "s", label: "S", prompt: "s" },
        { id: "x", label: "X", prompt: "x" },
        { id: "y", label: "Y", prompt: "y" },
        { id: "z", label: "Z", prompt: "z" },
      ],
      edges: [
        { from: START_NODE, to: "s" },
        { from: "s", to: "x", when: { op: "contains", value: "A" } },
        { from: "s", to: "y" },
        { from: "s", to: "z" },
        { from: "x", to: END_NODE },
        { from: "y", to: END_NODE },
        { from: "z", to: END_NODE },
      ],
    });
    expect(validateGraph(graph).some((p) => p.level === "error")).toBe(true);
  });

  it("accepts a cycle without complaint", () => {
    const graph = templateById("harness-arc")!;
    expect(validateGraph(graph).filter((p) => p.level === "error")).toEqual([]);
  });

  // An `equals` against a value outside `options` can never be true, because
  // `parseFields` only ever stores one of the options. The edge looks routed
  // on the canvas and silently never fires — which is how a graph cloned from
  // two templates with different verdict vocabularies breaks.
  const verdict = (value: string): Graph =>
    graphSchema.parse({
      id: "verdict",
      name: "Verdict",
      nodes: [
        {
          id: "critic",
          label: "Critic",
          prompt: "c",
          fields: [
            { name: "verdict", type: "enum", options: ["APPROVE", "REWORK"] },
          ],
        },
        { id: "worker", label: "Worker", prompt: "w" },
      ],
      edges: [
        { from: START_NODE, to: "critic" },
        {
          from: "critic",
          to: "worker",
          when: { source: "field", key: "verdict", op: "equals", value },
        },
        { from: "critic", to: END_NODE },
      ],
    });

  it("rejects an equals against a value the enum does not offer", () => {
    expect(
      validateGraph(verdict("NACHSCHAERFEN")).some(
        (p) => p.level === "error" && /allowed are/.test(p.message),
      ),
    ).toBe(true);
  });

  it("accepts an enum value regardless of case, as the runtime compares it", () => {
    expect(validateGraph(verdict("approve")).filter((p) => p.level === "error")).toEqual(
      [],
    );
  });

  it("rejects a placeholder that names no node, which would ship as literal text", () => {
    const graph = linear();
    graph.nodes[1].prompt = "Carry on with {{explore}}.";
    expect(
      validateGraph(graph).some(
        (p) => p.level === "error" && /\{\{explore\}\}/.test(p.message),
      ),
    ).toBe(true);
  });

  it("accepts {{input}} and placeholders naming a real node", () => {
    const graph = linear();
    graph.nodes[1].prompt = "{{input}} — build on {{a}}.";
    expect(validateGraph(graph).filter((p) => p.level === "error")).toEqual([]);
  });

  /**
   * A field placeholder renders empty rather than literal, so a typo here is
   * invisible in the prompt the worker receives — exactly the failure shape
   * this validator exists for.
   */
  const withFieldPlaceholder = (placeholder: string): Graph => {
    const graph = linear();
    graph.nodes[0]!.fields = [
      { name: "gap", type: "enum", options: ["NONE", "OPEN"], description: "" },
    ];
    graph.nodes[1]!.prompt = `Read ${placeholder}.`;
    return graph;
  };

  it("accepts {{node.field}} naming a declared field", () => {
    expect(
      validateGraph(withFieldPlaceholder("{{a.gap}}")).filter(
        (p) => p.level === "error",
      ),
    ).toEqual([]);
  });

  it("rejects a field placeholder naming no node", () => {
    expect(
      validateGraph(withFieldPlaceholder("{{ghost.gap}}")).some(
        (p) => p.level === "error" && /there is no node "ghost"/.test(p.message),
      ),
    ).toBe(true);
  });

  it("rejects a field placeholder naming a field nobody declares", () => {
    expect(
      validateGraph(withFieldPlaceholder("{{a.typo}}")).some(
        (p) => p.level === "error" && /declares no field "typo"/.test(p.message),
      ),
    ).toBe(true);
  });

  /**
   * Plan declares a list, review runs once per element. Every failure mode
   * below is the same shape as the ones this project keeps paying for: the
   * edge is drawn, the graph looks routed, and the branches silently never
   * happen — so each one is an error, not a warning.
   */
  const fanOut = (overrides: Record<string, unknown> = {}): Graph =>
    graphSchema.parse({
      id: "fan",
      name: "Fan",
      nodes: [
        {
          id: "plan",
          label: "Plan",
          prompt: "p",
          fields: [{ name: "dateien", type: "list" }],
        },
        { id: "review", label: "Review", prompt: "Prüfe {{item}}" },
        { id: "join", label: "Join", prompt: "Fasse zusammen: {{review}}" },
        ...((overrides.nodes as unknown[]) ?? []),
      ],
      edges: [
        { from: START_NODE, to: "plan" },
        { from: "plan", to: "review", fanOutOver: "dateien", ...overrides },
        { from: "review", to: "join" },
        { from: "join", to: END_NODE },
      ],
    });

  const errorsOf = (graph: Graph) =>
    validateGraph(graph)
      .filter((p) => p.level === "error")
      .map((p) => p.message);

  it("accepts a fan-out over a declared list field", () => {
    expect(errorsOf(fanOut())).toEqual([]);
  });

  it("rejects a fan-out over a field nobody declares", () => {
    expect(errorsOf(fanOut({ fanOutOver: "ghosts" })).join()).toMatch(
      /not declared/,
    );
  });

  it("rejects a fan-out over a field that is not a list", () => {
    const graph = fanOut();
    graph.nodes[0]!.fields = [{ name: "dateien", type: "string", options: [], description: "" }];
    expect(errorsOf(graph).join()).toMatch(/instead of "list"/);
  });

  it("rejects a fan-out edge that also carries a condition", () => {
    const graph = fanOut({
      when: { source: "field", key: "dateien", op: "contains", value: "x" },
    });
    expect(errorsOf(graph).join()).toMatch(/carries a condition/);
  });

  it("rejects a fanning node that has other outgoing edges", () => {
    const graph = fanOut();
    graph.edges.push(graphSchema.parse({
      id: "x", name: "X", nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "plan", to: "join" }],
    }).edges[0]!);
    expect(errorsOf(graph).join()).toMatch(/exactly one/);
  });

  // `{{item}}` is the only thing that distinguishes the branches. Without it
  // the fan-out spawns n identical threads, which is worse than not fanning
  // out at all — it costs n times as much for one answer.
  it("warns when a fan-out target never reads {{item}}", () => {
    const graph = fanOut();
    graph.nodes[1]!.prompt = "Review the change.";
    expect(
      validateGraph(graph).some(
        (p) => p.level === "warning" && /reads no \{\{item\}\}/.test(p.message),
      ),
    ).toBe(true);
  });

  it("rejects {{item}} in a node that is not a fan-out target", () => {
    const graph = fanOut();
    graph.nodes[2]!.prompt = "Fasse zusammen: {{item}}";
    expect(errorsOf(graph).join()).toMatch(/not the target of a fan-out/);
  });

  // A suspending node cannot be fanned out: n interrupts would queue on one
  // user, and the dialogue bookkeeping is keyed per node and visit.
  it("rejects a dialogue node as a fan-out target", () => {
    const graph = fanOut();
    graph.nodes[1]!.kind = "dialog";
    expect(errorsOf(graph).join()).toMatch(/cannot be the target of a fan-out/);
  });

  // Each branch parsed its own fields, so there is no single value to read.
  it("rejects an edge reading a field of a node that runs fanned out", () => {
    const graph = fanOut();
    graph.nodes[1]!.fields = [
      { name: "status", type: "enum", options: ["OK", "ROT"], description: "" },
    ];
    graph.edges[2]!.when = {
      source: "field",
      key: "review.status",
      op: "equals",
      value: "ROT",
    };
    expect(errorsOf(graph).join()).toMatch(/share no field value/);
  });

  // Same reason, other reader: a prompt may not render a field of a node whose
  // branches each parsed their own value.
  it("rejects a prompt reading a field of a node that runs fanned out", () => {
    const graph = fanOut();
    graph.nodes[1]!.fields = [
      { name: "status", type: "enum", options: ["OK", "ROT"], description: "" },
    ];
    graph.nodes[2]!.prompt = "Fasse zusammen: {{review}} ({{review.status}})";
    expect(errorsOf(graph).join()).toMatch(/share no field value/);
  });

  // A template embedding another one can only be judged against the library,
  // so the resolver is part of the check — and that makes this also a test
  // that the shipped subgraph template resolves against the shipped library.
  it("keeps every shipped template runnable", () => {
    for (const template of TEMPLATES) {
      expect(
        validateGraph(template, templateById).filter((p) => p.level === "error"),
        `${template.id} should be runnable`,
      ).toEqual([]);
    }
  });

  /**
   * What the worker of the very first node actually reads. A placeholder on a
   * back edge — `{{version}}` in `concept-waves`, `{{test}}` in the build
   * loops — names a node that has not run yet, and it used to arrive as those
   * literal braces under a line promising the spot would be empty. The
   * runtime hands `renderPrompt` the node names of the graph for exactly this,
   * and a template is where the effect is worth pinning down.
   */
  it("ships no template whose first pass shows literal braces", () => {
    for (const template of TEMPLATES) {
      const known = new Set(reachableNodeIds(template, templateById)!.keys());
      const state = emptyRunState("TASK");
      for (const node of template.nodes) {
        const composed =
          node.kind === "dialog"
            ? composeDialogPrompt(node, state, known)
            : composeNodePrompt(node, state, known);
        expect(composed, `${template.id}/${node.id} should resolve its placeholders`).not.toMatch(
          /\{\{/,
        );
      }
    }
  });

  /**
   * Warnings count too, because a shipped template is what people copy. The
   * check earned its place immediately: `deferred-choice` declared enum fields
   * on an approval node, which parses none — the edges asked about a value
   * that would never have been set, and only the warning said so.
   */
  it("ships no template that warns", () => {
    for (const template of TEMPLATES) {
      expect(
        validateGraph(template, templateById).map((problem) => problem.message),
        `${template.id} should be free of warnings`,
      ).toEqual([]);
    }
  });
});

describe("structured fields (regression)", () => {
  // History: a live run ended after two nodes because the critic wrote "not
  // good enough" and a `contains "ENOUGH"` edge read that as the stop signal.
  // Routing now compares declared fields, so prose cannot trigger an edge at
  // all — these tests pin that down rather than just anchoring the substring.
  it("ignores prose entirely and routes on the declared field", () => {
    const graph = templateById("evaluator-optimizer")!;
    const state = {
      ...emptyRunState("t"),
      outputs: {
        critique: "Not good enough. DONE would be a lie. Certainly not done.",
      },
      fields: { critique: { done: false } },
      visits: { critique: 1 },
    };
    expect(resolveNext(graph, "critique", state)).toBe("revise");
  });

  it("stops when the field says so, whatever the prose says", () => {
    const graph = templateById("evaluator-optimizer")!;
    expect(
      resolveNext(graph, "critique", {
        ...emptyRunState("t"),
        outputs: { critique: "Plenty left to do, CONTINUE!" },
        fields: { critique: { done: true } },
        visits: { critique: 1 },
      }),
    ).toBe(END_NODE);
  });

  it("routes the harness arc on critic.verdict", () => {
    const graph = templateById("harness-arc")!;
    const prose = "No REWORK needed, no BLOCK either — this holds.";
    expect(
      resolveNext(graph, "critic", {
        ...emptyRunState("t"),
        outputs: { critic: prose },
        fields: { critic: { verdict: "APPROVE" } },
      }),
    ).toBe("gate");
    expect(
      resolveNext(graph, "critic", {
        ...emptyRunState("t"),
        outputs: { critic: prose },
        fields: { critic: { verdict: "REWORK" } },
      }),
    ).toBe("worker");
  });

  it("routes the router on classify.kind", () => {
    const graph = templateById("routing")!;
    const at = (kind: string) =>
      resolveNext(graph, "classify", {
        ...emptyRunState("t"),
        fields: { classify: { kind } },
      });
    expect(at("BUG")).toBe("bug");
    expect(at("FEATURE")).toBe("feature");
    expect(at("FRAGE")).toBe("answer");
  });

  it("falls through to the fallback edge when the field is missing", () => {
    // A node that never ran has no fields; routing must not throw.
    const graph = templateById("routing")!;
    expect(resolveNext(graph, "classify", emptyRunState("t"))).toBe("answer");
  });

  it("rejects an edge that reads a field nobody declares", () => {
    const graph = graphSchema.parse({
      id: "typo",
      name: "Typo",
      nodes: [
        {
          id: "a",
          label: "A",
          prompt: "a",
          fields: [{ name: "verdict", type: "enum", options: ["JA", "NEIN"] }],
        },
        { id: "b", label: "B", prompt: "b" },
      ],
      edges: [
        { from: START_NODE, to: "a" },
        {
          from: "a",
          to: "b",
          when: { source: "field", key: "a.verdikt", op: "equals", value: "JA" },
        },
        { from: "a", to: END_NODE },
        { from: "b", to: END_NODE },
      ],
    });
    expect(
      validateGraph(graph).some(
        (p) => p.level === "error" && /verdikt/.test(p.message),
      ),
    ).toBe(true);
  });
});

describe("conditions and routing", () => {
  const state = {
    ...emptyRunState("task"),
    outputs: { critic: "REWORK\nneeds another pass" },
    fields: { critic: { verdict: "REWORK" } },
    visits: { worker: 2 },
  };

  it("matches contains case-insensitively", () => {
    expect(
      evaluateCondition(
        { source: "output", key: "critic", op: "contains", value: "rework" },
        state,
        "critic",
      ),
    ).toBe(true);
  });

  it("reads visit counts", () => {
    expect(
      evaluateCondition(
        { source: "output", key: "worker", op: "visitsBelow", value: "3" },
        state,
        "critic",
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { source: "output", key: "worker", op: "visitsBelow", value: "2" },
        state,
        "critic",
      ),
    ).toBe(false);
  });

  it("never throws on a broken regex", () => {
    expect(
      evaluateCondition(
        { source: "output", key: "critic", op: "matches", value: "([" },
        state,
        "critic",
      ),
    ).toBe(false);
  });

  it("routes back to worker on REWORK, and to the gate otherwise", () => {
    const graph = templateById("harness-arc")!;
    expect(resolveNext(graph, "critic", state)).toBe("worker");
    expect(
      resolveNext(graph, "critic", {
        ...state,
        fields: { critic: { verdict: "APPROVE" } },
      }),
    ).toBe("gate");
  });

  it("falls through to End when nothing matches", () => {
    expect(resolveNext(linear(), "b", emptyRunState(""))).toBe(END_NODE);
  });

  /**
   * A back edge on the last lap used to route into a node that could only
   * answer by throwing: the target was out of visits, the guard fired, and a
   * run that had a finished result in hand ended as an error. The router now
   * passes such an edge over and takes the next one.
   */
  describe("a target that is out of visits", () => {
    const spent = (worker: number) => ({ ...state, visits: { worker } });

    it("is skipped, so routing falls through to the next edge", () => {
      const graph = templateById("harness-arc")!;
      const worker = graph.nodes.find((node) => node.id === "worker")!;
      expect(resolveNext(graph, "critic", spent(worker.maxVisits))).toBe("gate");
    });

    it("still routes there while the budget lasts", () => {
      const graph = templateById("harness-arc")!;
      const worker = graph.nodes.find((node) => node.id === "worker")!;
      expect(resolveNext(graph, "critic", spent(worker.maxVisits - 1))).toBe("worker");
    });

    it("reports the skipped edge, so a loop that stops looping is not silent", () => {
      const graph = templateById("harness-arc")!;
      const worker = graph.nodes.find((node) => node.id === "worker")!;
      const { next, skipped } = routeFrom(graph, "critic", spent(worker.maxVisits));
      expect(next).toBe("gate");
      expect(skipped).toEqual([
        { to: "worker", label: worker.label, maxVisits: worker.maxVisits },
      ]);
    });

    it("ends the run when every matching edge is spent", () => {
      const graph = linear();
      expect(
        resolveNext(graph, "a", { ...emptyRunState(""), visits: { b: 99 } }),
      ).toBe(END_NODE);
    });
  });
});

/**
 * The contract the prompt must not contradict. A node that answers with fields
 * ends on a JSON block, so "nothing after" is an instruction the worker cannot
 * follow together with the format it is judged by — and `parseFields` turns
 * that into a failed attempt, not a readable complaint.
 */
describe("prompts against the answer format", () => {
  const withPrompt = (prompt: string, extra: Record<string, unknown> = {}): Graph =>
    graphSchema.parse({
      id: "contract",
      name: "Contract",
      nodes: [
        {
          id: "a",
          label: "A",
          prompt,
          fields: [
            { name: "intent", type: "enum", options: ["CONTINUE", "DONE"], description: "" },
          ],
          ...extra,
        },
      ],
      edges: [
        { from: START_NODE, to: "a" },
        { from: "a", to: END_NODE },
      ],
    });

  const warningsOf = (graph: Graph) =>
    validateGraph(graph)
      .filter((p) => p.level === "warning")
      .map((p) => p.message);

  it("warns when a node with fields forbids text after its answer", () => {
    expect(warningsOf(withPrompt("Write the document. Nothing after it.")).join()).toMatch(
      /nothing may follow/,
    );
  });

  // A dialogue node carries `DIALOG_CONTRACT` on *every* message, so the same
  // sentence breaks it even without declared fields.
  it("warns for a dialogue node even though it declares no fields", () => {
    const graph = withPrompt("Ask me. No text after your question.", { kind: "dialog" });
    graph.nodes[0]!.fields = [];
    expect(warningsOf(graph).join()).toMatch(/nothing may follow/);
  });

  // The positive case, and the one that keeps the rule from being a blanket
  // ban: a node may well say what its answer holds, as long as it leaves room
  // for the block that comes after it.
  it("stays silent when the prompt leaves room for the JSON block", () => {
    expect(
      warningsOf(
        withPrompt(
          "Write the document and no accompanying text. The JSON block below comes after it.",
        ),
      ),
    ).toEqual([]);
  });

  // A node without fields and without a dialogue gets no contract appended, so
  // there is nothing to contradict.
  it("stays silent for a node that answers with no JSON at all", () => {
    const graph = withPrompt("Consider correctness. Nothing after that.");
    graph.nodes[0]!.fields = [];
    expect(warningsOf(graph)).toEqual([]);
  });
});

describe("prompt rendering", () => {
  it("substitutes input, outputs and vars, and leaves unknowns alone", () => {
    const state = { ...emptyRunState("TASK"), outputs: { plan: "PLAN" } };
    expect(renderPrompt("{{input}} / {{plan}} / {{nope}}", state)).toBe(
      "TASK / PLAN / {{nope}}",
    );
  });

  it("renders {{node.field}} as the declared field's value", () => {
    const state = {
      ...emptyRunState("x"),
      fields: { critique: { gap: "OPEN", rounds: 2, good: true } },
    };
    expect(
      renderPrompt("{{critique.gap}} / {{critique.rounds}} / {{critique.good}}", state),
    ).toBe("OPEN / 2 / true");
  });

  it("renders a list field as a comma-separated line", () => {
    const state = { ...emptyRunState("x"), fields: { plan: { files: ["a.ts", "b.ts"] } } };
    expect(renderPrompt("{{plan.files}}", state)).toBe("a.ts, b.ts");
  });

  // The case a back edge depends on: on the first pass the node ahead has not
  // run, and literal braces would be shipped to the worker as if they were
  // content.
  it("renders a field of a node that has not run yet as nothing", () => {
    expect(renderPrompt("Gap: {{critique.gap}}.", emptyRunState("x"))).toBe(
      "Gap: .",
    );
  });

  /**
   * The same case for the whole-node placeholder, which used to keep its
   * braces: `concept-waves` reads its own output to carry a document through
   * several waves, and on the first wave the worker was handed the six
   * characters `{{version}}` under a line promising it would be empty.
   */
  it("renders a known node that has not run yet as nothing", () => {
    expect(
      renderPrompt("Draft:\n{{version}}", emptyRunState("x"), new Set(["version"])),
    ).toBe("Draft:\n");
  });

  // The other half of the same rule, and the reason it takes a set instead of
  // rendering every unresolved name empty: a placeholder naming no node is a
  // typo, and it stays visible rather than quietly deleting the context the
  // prompt was built around.
  it("leaves a placeholder that names no node standing, known set or not", () => {
    expect(
      renderPrompt("{{nope}}", emptyRunState("x"), new Set(["version"])),
    ).toBe("{{nope}}");
  });

  it("prefers the output over the empty rendering once the node has run", () => {
    const state = { ...emptyRunState("x"), outputs: { version: "## Problem" } };
    expect(renderPrompt("{{version}}", state, new Set(["version"]))).toBe(
      "## Problem",
    );
  });
});

describe("layout", () => {
  it("places Start above End and gives every node a box", () => {
    const layout = layoutGraph(linear());
    const start = layout.nodes.find((node) => node.id === START_NODE)!;
    const end = layout.nodes.find((node) => node.id === END_NODE)!;
    expect(start.y).toBeLessThan(end.y);
    expect(layout.nodes).toHaveLength(4);
  });

  it("marks the critic→worker edge as a back edge so it is drawn as an arc", () => {
    const layout = layoutGraph(templateById("harness-arc")!);
    const back = layout.edges.filter((edge) => edge.isBack);
    expect(back.map((edge) => `${edge.from}->${edge.to}`)).toContain(
      "critic->worker",
    );
  });

  it("terminates on a cyclic graph and keeps layers finite", () => {
    const layout = layoutGraph(templateById("evaluator-optimizer")!);
    expect(Number.isFinite(layout.height)).toBe(true);
    expect(layout.nodes.every((node) => Number.isFinite(node.y))).toBe(true);
  });

  // The gap between two layers exists to hold the arrow's caption. Without a
  // caption it must stay tight — a rule that reads plausibly and never fires
  // is exactly the failure this project keeps paying for, so the negative case
  // is asserted first.
  const gapBelow = (layout: ReturnType<typeof layoutGraph>, id: string) => {
    const node = layout.nodes.find((entry) => entry.id === id)!;
    const below = layout.nodes
      .filter((entry) => entry.layer === node.layer + 1)
      .at(0)!;
    return below.y - (node.y + node.height);
  };

  it("keeps an unlabelled gap tight", () => {
    const layout = layoutGraph(linear());
    expect(gapBelow(layout, "a")).toBe(LAYER_GAP_TIGHT);
  });

  it("widens only the gap whose edge carries a caption", () => {
    const graph = linear();
    graph.edges = graph.edges.map((edge) =>
      edge.from === "a" && edge.to === "b" ? { ...edge, label: "when done" } : edge,
    );
    const layout = layoutGraph(graph);
    expect(gapBelow(layout, "a")).toBe(LAYER_GAP_LABELLED);
    expect(gapBelow(layout, START_NODE)).toBe(LAYER_GAP_TIGHT);
    expect(gapBelow(layout, "b")).toBe(LAYER_GAP_TIGHT);
  });

  // End used to be pushed one layer below the row the relaxation had already
  // given it, so every graph carried an empty row of canvas above the End
  // pill. Nothing looked wrong — the picture was just taller than the graph.
  it("puts End on the row right below the last node, leaving no empty row", () => {
    const layout = layoutGraph(linear());
    const b = layout.nodes.find((node) => node.id === "b")!;
    const end = layout.nodes.find((node) => node.id === END_NODE)!;
    expect(end.layer).toBe(b.layer + 1);
    expect(end.y - (b.y + b.height)).toBe(LAYER_GAP_TIGHT);
  });

  it("is shorter without captions than with them", () => {
    const plain = layoutGraph(linear());
    const labelled = linear();
    labelled.edges = labelled.edges.map((edge) => ({ ...edge, label: "ja" }));
    expect(plain.height).toBeLessThan(layoutGraph(labelled).height);
  });
});

/**
 * A cycle may lead back into a fan-out. Without the visit stamp the second
 * pass would append to the first, and the join node would read fourteen
 * results where seven ran — the kind of wrong that still looks plausible.
 */
describe("collected results", () => {
  it("keeps only the newest visit's branches", () => {
    const merged = mergeCollected(
      [
        { visit: 1, text: "alt a" },
        { visit: 1, text: "alt b" },
      ],
      [{ visit: 2, text: "neu a" }],
    );
    expect(merged).toEqual([{ visit: 2, text: "neu a" }]);
  });

  it("collects branches of the same visit", () => {
    const merged = mergeCollected(
      [{ visit: 1, text: "a" }],
      [{ visit: 1, text: "b" }],
    );
    expect(merged).toHaveLength(2);
  });

  it("renders collected results into a prompt, numbered", () => {
    const state = {
      ...emptyRunState("x"),
      collected: {
        review: [
          { visit: 1, text: "erstes" },
          { visit: 1, text: "zweites" },
        ],
      },
    };
    const rendered = renderPrompt("Bündele: {{review}}", state);
    expect(rendered).toContain("1 of 2");
    expect(rendered).toContain("erstes");
    expect(rendered).toContain("zweites");
  });

  it("renders {{item}} as the branch's own element", () => {
    const state = { ...emptyRunState("x"), item: "a.ts" };
    expect(renderPrompt("Prüfe {{item}}", state)).toBe("Prüfe a.ts");
  });
});

describe("fan-out on the canvas", () => {
  // A fan-out is one drawn arrow standing for n branches. Without a label the
  // reader counts one, which is the same "looks plausible, is not" problem the
  // validator exists for — only in the drawing rather than in the run.
  it("labels a fan-out edge with what it branches over", () => {
    const graph = graphSchema.parse({
      id: "fan-label",
      name: "Fan",
      nodes: [
        {
          id: "plan",
          label: "Plan",
          prompt: "p",
          fields: [{ name: "dateien", type: "list" }],
        },
        { id: "review", label: "Review", prompt: "{{item}}" },
      ],
      edges: [
        { from: START_NODE, to: "plan" },
        { from: "plan", to: "review", fanOutOver: "dateien" },
        { from: "review", to: END_NODE },
      ],
    });
    const edge = layoutGraph(graph).edges.find(
      (entry) => entry.from === "plan" && entry.to === "review",
    )!;
    expect(edge.label).toBe("per entry in dateien");
  });
});


/**
 * A fanned-out node has no single status — it is n of them. The canvas used to
 * show whichever branch was written last, which reads as "fertig" while four
 * of seven are still running.
 */
describe("fan-out progress", () => {
  const graph = (): Graph =>
    graphSchema.parse({
      id: "fan-progress",
      name: "Fan",
      maxFanOut: 3,
      nodes: [
        {
          id: "plan",
          label: "Plan",
          prompt: "p",
          fields: [{ name: "dateien", type: "list" }],
        },
        { id: "review", label: "Review", prompt: "{{item}}" },
      ],
      edges: [
        { from: START_NODE, to: "plan" },
        { from: "plan", to: "review", fanOutOver: "dateien" },
        { from: "review", to: END_NODE },
      ],
    });

  const stateWith = (items: string[], done: number) => ({
    ...emptyRunState("x"),
    fields: { plan: { dateien: items } },
    collected: {
      review: Array.from({ length: done }, (_, i) => ({
        visit: 1,
        text: `r${i}`,
      })),
    },
  });

  it("counts finished branches against the total", () => {
    const progress = fanOutProgress(graph(), stateWith(["a", "b", "c"], 2));
    expect(progress.review).toEqual({ done: 2, total: 3 });
  });

  it("reports nothing before the list exists, so no node claims 0 of 0", () => {
    expect(fanOutProgress(graph(), emptyRunState("x"))).toEqual({});
  });

  // The total must respect the cap, or the canvas counts up to a number of
  // branches that were never started.
  it("counts against the capped total, not the raw list", () => {
    const progress = fanOutProgress(
      graph(),
      stateWith(["a", "b", "c", "d", "e"], 3),
    );
    expect(progress.review).toEqual({ done: 3, total: 3 });
  });
});

/**
 * Per-node model choice. The fields existed in the schema long before anything
 * set them, and `server.ts` forwards a provider and a model only together — so
 * the failure mode here is not a crash but a node that runs on the inherited
 * model while the editor shows the one that was picked. Every test below is
 * therefore a negative case: it asserts that half a selection is refused.
 */
describe("model per node", () => {
  const withNode = (patch: Record<string, unknown>): Graph => {
    const graph = linear();
    graph.nodes[0] = { ...graph.nodes[0]!, ...patch } as Graph["nodes"][number];
    return graph;
  };
  const errors = (graph: Graph) =>
    validateGraph(graph).filter((p) => p.level === "error");

  it("accepts a node with provider and model together", () => {
    const graph = withNode({ providerId: "claude-code", model: "claude-opus-5" });
    expect(errors(graph)).toEqual([]);
    expect(nodeExecution(graph.nodes[0]!)).toEqual({
      providerId: "claude-code",
      model: "claude-opus-5",
      reasoningLevel: null,
      serviceTier: null,
    });
  });

  it("rejects a provider without a model", () => {
    expect(
      errors(withNode({ providerId: "claude-code" })).some((p) =>
        /no model/.test(p.message),
      ),
    ).toBe(true);
  });

  it("rejects a model without a provider", () => {
    expect(
      errors(withNode({ model: "claude-opus-5" })).some((p) =>
        /no provider/.test(p.message),
      ),
    ).toBe(true);
  });

  // Whitespace is not a selection. Without the trim a node could hold " " and
  // pass the "both set" test while BB drops it.
  it("treats blank strings as no selection at all", () => {
    const graph = withNode({ providerId: "  ", model: "  " });
    expect(nodeExecution(graph.nodes[0]!)).toBeNull();
    expect(errors(graph)).toEqual([]);
  });

  it("rejects a reasoning level without provider and model", () => {
    expect(
      errors(withNode({ reasoningLevel: "high" })).some((p) =>
        /reasoning level/.test(p.message),
      ),
    ).toBe(true);
  });

  it("rejects a service tier without provider and model", () => {
    expect(
      errors(withNode({ serviceTier: "fast" })).some((p) =>
        /service tier/.test(p.message),
      ),
    ).toBe(true);
  });

  // A note documents and an approval node waits for a person; neither spawns a
  // worker, so a model there would look set and never apply.
  it("warns about a model on a node that never spawns a worker", () => {
    const graph = withNode({
      kind: "note",
      providerId: "claude-code",
      model: "claude-opus-5",
    });
    expect(
      validateGraph(graph).some(
        (p) => p.level === "warning" && /starts no worker/.test(p.message),
      ),
    ).toBe(true);
  });

  it("leaves a node without a selection inheriting the parent", () => {
    expect(nodeExecution(linear().nodes[0]!)).toBeNull();
  });
});

/**
 * Subgraphs. An embedded graph runs inside the same LangGraph and shares the
 * same state — that sharing is what makes it worth having (a later node reads
 * a child's result) and it is also where every failure mode comes from. All of
 * them are silent: each graph is valid on its own, and only the combination is
 * wrong. So the validator needs the library, and every rule below is a
 * negative case.
 */
describe("subgraphs", () => {
  const child = (): Graph =>
    graphSchema.parse({
      id: "child",
      name: "Child",
      nodes: [
        {
          id: "work",
          label: "Work",
          prompt: "do {{input}}",
          fields: [{ name: "status", type: "enum", options: ["OK", "RED"] }],
        },
      ],
      edges: [
        { from: START_NODE, to: "work" },
        { from: "work", to: END_NODE },
      ],
    });

  const parent = (patch: Record<string, unknown> = {}): Graph =>
    graphSchema.parse({
      id: "parent",
      name: "Parent",
      nodes: [
        { id: "before", label: "Before", kind: "subgraph", graphId: "child", ...patch },
        { id: "after", label: "After", prompt: "read {{work}}" },
      ],
      edges: [
        { from: START_NODE, to: "before" },
        { from: "before", to: "after" },
        { from: "after", to: END_NODE },
      ],
    });

  const library = (...graphs: Graph[]) => (id: string) =>
    graphs.find((entry) => entry.id === id) ?? null;
  const errors = (graph: Graph, resolve = library(child())) =>
    validateGraph(graph, resolve).filter((p) => p.level === "error");

  it("accepts a graph that embeds another and reads its result", () => {
    expect(errors(parent())).toEqual([]);
  });

  // Without the library there is nothing to check against, and a subgraph node
  // would have to be waved through — so the resolver is not optional in
  // practice, and this pins that the default resolver refuses rather than
  // blesses.
  it("rejects a subgraph when the library is not available", () => {
    expect(
      validateGraph(parent())
        .filter((p) => p.level === "error")
        .some((p) => /which does not exist/.test(p.message)),
    ).toBe(true);
  });

  it("rejects a node naming no graph at all", () => {
    expect(
      errors(parent({ graphId: "" })).some((p) => /names no graph/.test(p.message)),
    ).toBe(true);
  });

  it("rejects a graph embedding itself", () => {
    expect(
      errors(parent({ graphId: "parent" })).some((p) => /embeds its own graph/.test(p.message)),
    ).toBe(true);
  });

  // Two graphs embedding each other would recurse forever. Neither is wrong on
  // its own, which is why this has to be checked across the boundary.
  it("rejects graphs that embed each other in a circle", () => {
    const a = graphSchema.parse({
      id: "a",
      name: "A",
      nodes: [{ id: "an", label: "AN", kind: "subgraph", graphId: "b" }],
      edges: [
        { from: START_NODE, to: "an" },
        { from: "an", to: END_NODE },
      ],
    });
    const b = graphSchema.parse({
      id: "b",
      name: "B",
      nodes: [{ id: "bn", label: "BN", kind: "subgraph", graphId: "a" }],
      edges: [
        { from: START_NODE, to: "bn" },
        { from: "bn", to: END_NODE },
      ],
    });
    expect(
      errors(a, library(a, b)).some((p) => /in a circle/.test(p.message)),
    ).toBe(true);
  });

  // The expensive one: both graphs are valid, the canvas looks right, and the
  // child's result quietly overwrites the parent's under the same key.
  it("rejects a node id that exists on both sides of the boundary", () => {
    const collide = graphSchema.parse({
      id: "parent",
      name: "Parent",
      nodes: [
        { id: "before", label: "Before", kind: "subgraph", graphId: "child" },
        { id: "work", label: "Also Work", prompt: "x" },
      ],
      edges: [
        { from: START_NODE, to: "before" },
        { from: "before", to: "work" },
        { from: "work", to: END_NODE },
      ],
    });
    expect(
      errors(collide).some((p) => /share state/.test(p.message)),
    ).toBe(true);
  });

  it("rejects an embedded graph that is not runnable itself", () => {
    const broken = graphSchema.parse({
      id: "child",
      name: "Child",
      nodes: [{ id: "work", label: "Work", prompt: "{{nosuchthing}}" }],
      edges: [
        { from: START_NODE, to: "work" },
        { from: "work", to: END_NODE },
      ],
    });
    expect(
      errors(parent(), library(broken)).some((p) =>
        /not runnable itself/.test(p.message),
      ),
    ).toBe(true);
  });

  // A subgraph node writes nothing under its own id — the children do. An edge
  // or a placeholder pointing at it therefore reads an empty slot and never
  // fires, which is indistinguishable from "not reached yet" on the canvas.
  it("rejects an edge reading the subgraph node's own text", () => {
    const graph = parent();
    graph.edges[1] = {
      ...graph.edges[1]!,
      when: { source: "output", key: "before", op: "contains", value: "done" },
    };
    expect(errors(graph).some((p) => /writes nothing itself/.test(p.message))).toBe(
      true,
    );
  });

  it("rejects a placeholder naming the subgraph node", () => {
    const graph = parent();
    graph.nodes[1] = { ...graph.nodes[1]!, prompt: "read {{before}}" };
    expect(errors(graph).some((p) => /writes nothing itself/.test(p.message))).toBe(
      true,
    );
  });

  it("lets a later node route on a field declared inside the child", () => {
    const graph = parent();
    graph.edges[1] = {
      ...graph.edges[1]!,
      when: { source: "field", key: "work.status", op: "equals", value: "OK" },
    };
    expect(errors(graph)).toEqual([]);
  });

  // n parallel children, each possibly containing an approval node, would queue
  // n interrupts on one person — and whether the child contains one is not
  // visible on the fanning edge.
  it("rejects a subgraph as the target of a fan-out", () => {
    const graph = graphSchema.parse({
      id: "parent",
      name: "Parent",
      nodes: [
        {
          id: "plan",
          label: "Plan",
          prompt: "p",
          fields: [{ name: "parts", type: "list" }],
        },
        { id: "before", label: "Before", kind: "subgraph", graphId: "child" },
      ],
      edges: [
        { from: START_NODE, to: "plan" },
        { from: "plan", to: "before", fanOutOver: "plan.parts" },
        { from: "before", to: END_NODE },
      ],
    });
    expect(
      errors(graph).some((p) => /cannot be the target of a fan-out/.test(p.message)),
    ).toBe(true);
  });

  it("warns about a prompt on a subgraph node, which reaches nobody", () => {
    expect(
      validateGraph(parent({ prompt: "do something" }), library(child())).some(
        (p) => p.level === "warning" && /nobody receives it/.test(p.message),
      ),
    ).toBe(true);
  });
});

describe("spawnExecution", () => {
  const explicit = {
    providerId: "claude-code",
    model: "claude-opus-5",
    reasoningLevel: null,
    serviceTier: null,
  };

  it("passes an explicit choice through unchanged", () => {
    expect(spawnExecution(explicit, "pi")).toEqual({
      providerId: "claude-code",
      model: "claude-opus-5",
      reasoningLevel: null,
      serviceTier: null,
      explicit: true,
    });
  });

  it("inherits the parent thread's provider when the node chooses none", () => {
    // The actual bug: without this the same graph ran once on claude-code
    // and once on pi, depending on BB's default.
    expect(spawnExecution(null, "claude-code")).toEqual({
      providerId: "claude-code",
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      explicit: false,
    });
  });

  // Negative case: inherited is not chosen. With explicit: true here, BB would
  // record a default as a deliberate decision.
  it("does not mark what was inherited as explicit", () => {
    expect(spawnExecution(null, "pi")?.explicit).toBe(false);
    expect(spawnExecution(null, "pi")?.model).toBeNull();
  });

  // Negative case: with no parent provider there is nothing to inherit — the
  // function then has to stay quiet rather than invent one.
  it("returns null when there is nothing to inherit", () => {
    expect(spawnExecution(null, null)).toBeNull();
    expect(spawnExecution(null, "")).toBeNull();
    expect(spawnExecution(null, "   ")).toBeNull();
  });

  // Negative case: the node's choice beats the parent provider, never the
  // other way round.
  it("does not let the parent provider override an explicit choice", () => {
    expect(spawnExecution(explicit, "pi")?.providerId).toBe("claude-code");
  });
});
