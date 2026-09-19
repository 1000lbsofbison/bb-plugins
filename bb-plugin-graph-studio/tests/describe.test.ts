import { describe, expect, it } from "vitest";
import { END_NODE, START_NODE, graphSchema, validateGraph, type Graph } from "../lib/graph";
import {
  describeAttempt,
  describeCost,
  describeGraph,
  describeLibrary,
  runCommand,
  runTotal,
  shellQuote,
} from "../lib/describe";
import {
  TEMPLATES,
  groupedLibrary,
  sectionGroup,
  templateById,
  templateGroup,
  templateSection,
} from "../lib/templates";

const routed = (): Graph =>
  graphSchema.parse({
    id: "routed",
    name: "Routed",
    description: "One node decides, the other works.",
    nodes: [
      {
        id: "check",
        label: "Check",
        kind: "dialog",
        prompt: "p",
        skills: ["grilling"],
        fields: [{ name: "verdict", type: "enum", options: ["GREEN", "RED"] }],
        maxVisits: 2,
      },
      { id: "work", label: "Work", prompt: "a", maxVisits: 1 },
    ],
    edges: [
      { from: START_NODE, to: "check" },
      {
        from: "check",
        to: "work",
        when: { source: "field", key: "check.verdict", op: "equals", value: "RED" },
      },
      { from: "check", to: END_NODE },
      { from: "work", to: "check" },
    ],
  });

describe("describeLibrary", () => {
  it("lists id, node count and name per graph", () => {
    const text = describeLibrary([routed()]);
    expect(text).toContain("routed");
    expect(text).toContain("2 nodes");
    expect(text).toContain("Routed");
    // One heading, one entry — a graph is still exactly one line.
    expect(text.split("\n").filter((line) => line.startsWith("  "))).toHaveLength(1);
  });

  it("says so when the library is empty instead of returning nothing", () => {
    expect(describeLibrary([])).toBe("No graphs.");
  });

  /**
   * A graph nobody ships is somebody's own, and that is the first thing the
   * reader wants to know — so it heads the listing rather than sitting among
   * the templates.
   */
  it("puts a saved graph under its own heading, first", () => {
    const text = describeLibrary([routed(), templateById("routing")!]);
    expect(text.split("\n")[0]).toBe("Your graphs");
    expect(text).toContain("Patterns");
  });

  it("separates patterns from this repo's own routines", () => {
    const text = describeLibrary([
      templateById("ensemble-vote")!,
      templateById("dev-tdd")!,
    ]);
    const pattern = text.indexOf("ensemble-vote");
    const work = text.indexOf("dev-tdd");
    expect(text).toContain("Patterns — established flows");
    expect(text).toContain("Work — flows for this repo");
    expect(pattern).toBeLessThan(work);
  });

  it("leaves out a heading with nothing under it", () => {
    expect(describeLibrary([templateById("routing")!])).not.toContain("Work —");
  });
});

describe("template groups", () => {
  /**
   * An unassigned template would silently be listed as somebody's own graph.
   * Cheap to prevent, and the kind of thing a new template forgets.
   */
  it("assigns every shipped template to a group", () => {
    const unassigned = TEMPLATES.filter((graph) => templateGroup(graph.id) === null);
    expect(unassigned.map((graph) => graph.id)).toEqual([]);
  });

  it("reports null for an id the library does not ship", () => {
    expect(templateGroup("something-somebody-saved")).toBeNull();
  });
});

/**
 * The finer shelves are a second assignment over the same ids, which is the
 * kind of thing that half-lands: a new template gets a group and no section,
 * and then it quietly disappears from the picker while the CLI still lists it.
 */
describe("template sections", () => {
  it("assigns every shipped template to a section", () => {
    const unassigned = TEMPLATES.filter((graph) => templateSection(graph.id) === null);
    expect(unassigned.map((graph) => graph.id)).toEqual([]);
  });

  it("reports null for an id the library does not ship", () => {
    expect(templateSection("something-somebody-saved")).toBeNull();
  });

  it("puts every template on a shelf inside its own group", () => {
    const wrong = TEMPLATES.filter(
      (graph) => sectionGroup(templateSection(graph.id)!) !== templateGroup(graph.id),
    );
    expect(wrong.map((graph) => graph.id)).toEqual([]);
  });

  /**
   * The fine gliederung is the picker's business. The terminal listing asked
   * for two headings and must keep getting two, so the default stays coarse —
   * and a default that silently turned fine would bury the pattern/work
   * distinction under ten subheadings.
   */
  it("keeps the coarse headings unless the finer ones are asked for", () => {
    const both = [templateById("ensemble-vote")!, templateById("dev-tdd")!];
    expect(groupedLibrary(both).map((section) => section.label)).toEqual([
      "Patterns — established flows",
      "Work — flows for this repo",
    ]);
    expect(groupedLibrary(both, "section").map((section) => section.label)).toEqual([
      "Patterns — several branches at once",
      "Work — building",
    ]);
  });

  it("tells a saved graph apart from a shipped one on the section itself", () => {
    const mine = { ...templateById("routing")!, id: "mine", name: "Mine" };
    const sections = groupedLibrary([mine, templateById("routing")!], "section");
    expect(sections.map((section) => section.group)).toEqual([null, "pattern"]);
  });

  it("leaves out a fine heading with nothing under it", () => {
    const labels = groupedLibrary([templateById("routing")!], "section").map(
      (section) => section.label,
    );
    expect(labels).toEqual(["Patterns — one branch chosen"]);
  });
});

describe("describeGraph", () => {
  const text = () => describeGraph(routed(), validateGraph(routed()));

  it("names the kind, skills, fields and visit budget of a node", () => {
    expect(text()).toContain("[dialog] check — Check");
    expect(text()).toContain("skills: grilling");
    expect(text()).toContain("verdict(GREEN|RED)");
    expect(text()).toContain("max 2×");
  });

  it("spells out the routing condition of a conditional edge", () => {
    expect(text()).toContain("check → work  if check.verdict equals RED");
  });

  it("leaves an unconditional edge bare", () => {
    expect(text()).toContain(`  work → check\n`);
  });

  it("omits what does not apply: no skills, no fields, no visit budget", () => {
    const rendered = text();
    const line = rendered
      .split("\n")
      .find((entry) => entry.includes("[agent] work"));
    expect(line).toBe("  [agent] work — Work");
  });

  it("marks a fan-out edge as one arrow standing for n branches", () => {
    const graph = graphSchema.parse({
      id: "fan",
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
        { from: "plan", to: "review", fanOutOver: "plan.dateien" },
        { from: "review", to: END_NODE },
      ],
      maxFanOut: 5,
    });
    expect(describeGraph(graph, [])).toContain(
      "plan → review  per entry in plan.dateien (max 5)",
    );
  });

  it("states that a clean graph is clean — silence would read as 'never checked'", () => {
    expect(describeGraph(routed(), [])).toContain("Check found nothing.");
  });

  it("carries the validator's findings instead of hiding them", () => {
    const broken = routed();
    broken.edges = broken.edges.filter((edge) => edge.from !== START_NODE);
    const rendered = describeGraph(broken, validateGraph(broken));
    expect(rendered).toContain("error:");
    expect(rendered).not.toContain("Check found nothing.");
  });

  it("renders every shipped template without throwing", () => {
    for (const template of TEMPLATES) {
      expect(describeGraph(template, validateGraph(template))).toContain(template.id);
    }
  });
});

/**
 * Cost rendering. One implementation for CLI and panel, because two would
 * drift and then "what did that run cost" depends on where you looked.
 */
describe("describeCost", () => {
  const run = (patch: Record<string, number | null>) => ({
    startedAt: null,
    endedAt: null,
    inputTokens: null,
    outputTokens: null,
    ...patch,
  });

  it("reports duration and tokens together", () => {
    expect(
      describeCost(
        run({ startedAt: 0, endedAt: 12_000, inputTokens: 900, outputTokens: 350 }),
      ),
    ).toBe("12 s · 1.3k tokens");
  });

  it("reads minutes as minutes", () => {
    expect(describeCost(run({ startedAt: 0, endedAt: 125_000 }))).toBe("2 min 05 s");
  });

  // The negative case this feature exists for: an unmeasured node must say
  // nothing. "0 tokens" would be a claim that it ran for free, and nobody
  // could tell that apart from a genuine zero afterwards.
  it("says nothing about tokens that were never measured", () => {
    expect(describeCost(run({ startedAt: 0, endedAt: 3_000 }))).toBe("3 s");
    expect(describeCost(run({}))).toBe("");
  });

  it("still reports a measured zero", () => {
    expect(describeCost(run({ inputTokens: 0, outputTokens: 0 }))).toBe("0 tokens");
  });
});

describe("runTotal", () => {
  it("sums only what was measured and says how much was not", () => {
    expect(
      runTotal([
        { inputTokens: 1_000, outputTokens: 500 },
        { inputTokens: null, outputTokens: null },
      ]),
    ).toBe("Total: 1.5k tokens across 1 node runs (1 unmeasured)");
  });

  it("stays silent when nothing was measured at all", () => {
    expect(runTotal([{ inputTokens: null, outputTokens: null }])).toBe("");
    expect(runTotal([])).toBe("");
  });
});

/**
 * The command the panel offers to copy. It is built here, not in the UI, so
 * that the line on screen and the line on the clipboard cannot differ — and so
 * the quoting can be tested without a browser.
 */
describe("runCommand", () => {
  const graph = (example: string): Graph =>
    graphSchema.parse({
      id: "my-graph",
      name: "My Graph",
      example,
      nodes: [{ id: "a", label: "A", prompt: "a" }],
      edges: [
        { from: START_NODE, to: "a" },
        { from: "a", to: END_NODE },
      ],
    });

  it("uses the graph's own example when no task was typed", () => {
    expect(runCommand(graph("The wishlist keeps losing entries"))).toBe(
      'bb graph-studio run my-graph "The wishlist keeps losing entries"',
    );
  });

  it("prefers the typed task over the example", () => {
    expect(runCommand(graph("Example"), "Something else")).toBe(
      'bb graph-studio run my-graph "Something else"',
    );
  });

  // The negative case that matters: a task of only whitespace is not a task.
  // Taking it at face value would hand out a command with an empty argument
  // and quietly lose the example that was the point of the line.
  it("falls back to the example when the typed task is only whitespace", () => {
    expect(runCommand(graph("Example"), "   ")).toBe(
      'bb graph-studio run my-graph "Example"',
    );
  });

  // An empty argument is not the honest fallback: `run my-graph ""` runs,
  // and starts a graph with no task at all.
  it("asks to be filled in when there is no example and no task", () => {
    expect(runCommand(graph(""))).toBe(
      'bb graph-studio run my-graph "<task>"',
    );
  });
});

/**
 * A copy button that hands out a broken command is worse than no button: it
 * fails in the terminal, where nothing explains why.
 */
describe("shellQuote", () => {
  it("leaves ordinary German prose alone", () => {
    expect(shellQuote("Sortierung im Filter, serverseitig")).toBe(
      '"Sortierung im Filter, serverseitig"',
    );
  });

  it("escapes the four characters the shell still reads inside double quotes", () => {
    expect(shellQuote('sag "hallo"')).toBe('"sag \\"hallo\\""');
    expect(shellQuote("Pfad C:\\tmp")).toBe('"Pfad C:\\\\tmp"');
    expect(shellQuote("Kosten in $HOME")).toBe('"Kosten in \\$HOME"');
    expect(shellQuote("run `ls`")).toBe('"run \\`ls\\`"');
  });

  it("keeps an apostrophe unescaped, which is why the quotes are double", () => {
    expect(shellQuote("wie geht's")).toBe('"wie geht\'s"');
  });
});

/**
 * The example is the only line that says what a graph is *fed*. A template
 * without one is a template whose command line degenerates into a syntax
 * lesson — so the rule is checked rather than trusted.
 */
describe("template examples", () => {
  it("gives every built-in graph an example task", () => {
    const without = TEMPLATES.filter((graph) => graph.example.trim() === "");
    expect(without.map((graph) => graph.id)).toEqual([]);
  });

  it("shows the example in the text form a person or model reads", () => {
    const graph = TEMPLATES.find((entry) => entry.id === "dev-bugfix")!;
    expect(describeGraph(graph, [])).toContain(
      `Example: bb graph-studio run dev-bugfix "${graph.example}"`,
    );
  });
});

// The status line of `bb graph-studio status`. A run that takes ten minutes is
// watched from the terminal as often as from the panel, and "running write
// (attempt 1)" is as little help there as "running" was on the canvas.
describe("describeAttempt", () => {
  const attempt = (patch: Record<string, unknown>) => ({
    nodeId: "write",
    attempt: 1,
    status: "running",
    childThreadId: "thr_7",
    startedAt: 0,
    endedAt: null,
    inputTokens: null,
    outputTokens: null,
    activity: null,
    ...patch,
  });

  it("gives a running attempt its clock and its activity", () => {
    expect(describeAttempt(attempt({ activity: "Running vitest" }), 252_000)).toBe(
      "  running  write (attempt 1)  running 4:12 · Running vitest  → thr_7",
    );
  });

  it("still gives the clock when the worker has said nothing yet", () => {
    expect(describeAttempt(attempt({ activity: null }), 65_000)).toBe(
      "  running  write (attempt 1)  running 1:05  → thr_7",
    );
  });

  // A finished attempt is judged by what it cost, not by how long ago it was
  // still going — so the clock gives way to the cost the moment it ends.
  it("gives a finished attempt its cost instead", () => {
    expect(
      describeAttempt(
        attempt({
          status: "done",
          endedAt: 12_000,
          inputTokens: 900,
          outputTokens: 350,
          activity: "Running vitest",
        }),
        900_000,
      ),
    ).toBe("  done     write (attempt 1)  12 s · 1.3k tokens  → thr_7");
  });

  it("says only what it knows about an attempt with no worker and no numbers", () => {
    expect(
      describeAttempt(
        attempt({ status: "skipped", childThreadId: null, startedAt: null }),
        900_000,
      ),
    ).toBe("  skipped  write (attempt 1)");
  });
});
