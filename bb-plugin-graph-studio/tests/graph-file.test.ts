// The JSON file format: a graph as a versioned, repo-checkable config.
import { describe, expect, it } from "vitest";
import { GRAPH_FILE_VERSION, fromGraphFile, toGraphFile } from "../server";
import { graphSchema, composeNodePrompt, emptyRunState } from "../lib/graph";
import { templateById } from "../lib/templates";

describe("graph file", () => {
  it("round-trips a graph through the file format", () => {
    const graph = templateById("harness-arc")!;
    const restored = fromGraphFile(toGraphFile(graph));
    expect(restored.id).toBe(graph.id);
    expect(restored.nodes).toEqual(graph.nodes);
    expect(restored.edges).toEqual(graph.edges);
  });

  it("writes a versioned envelope and drops row timestamps", () => {
    const graph = { ...templateById("routing")!, createdAt: 111, updatedAt: 222 };
    const file = JSON.parse(toGraphFile(graph));
    expect(file.version).toBe(GRAPH_FILE_VERSION);
    expect(file.graph).not.toHaveProperty("createdAt");
    expect(file.graph).not.toHaveProperty("updatedAt");
    // Restored copies start at 0 and get their real dates from the store.
    expect(fromGraphFile(toGraphFile(graph)).createdAt).toBe(0);
  });

  it("ends with a newline so it is a well-formed text file", () => {
    expect(toGraphFile(templateById("routing")!).endsWith("\n")).toBe(true);
  });

  it("accepts a bare hand-written graph object without an envelope", () => {
    const bare = JSON.stringify({
      id: "handgeschrieben",
      name: "Handgeschrieben",
      nodes: [{ id: "a", label: "A", prompt: "{{input}}" }],
      edges: [
        { from: "__start__", to: "a" },
        { from: "a", to: "__end__" },
      ],
    });
    const graph = fromGraphFile(bare);
    expect(graph.id).toBe("handgeschrieben");
    // Schema defaults fill in the rest.
    expect(graph.nodes[0]!.maxVisits).toBe(3);
    expect(graph.nodes[0]!.skills).toEqual([]);
  });

  it("refuses a file from a newer format version", () => {
    const future = JSON.stringify({ version: GRAPH_FILE_VERSION + 1, graph: {} });
    expect(() => fromGraphFile(future)).toThrow(/version/);
  });

  it("reports broken JSON and invalid graphs distinctly", () => {
    expect(() => fromGraphFile("{nope")).toThrow(/not valid JSON/);
    expect(() => fromGraphFile(JSON.stringify({ id: "X!", name: "" }))).toThrow(
      /invalid/,
    );
  });
});

describe("skills on a node", () => {
  const state = emptyRunState("TASK");

  it("leaves a prompt untouched when no skill is named", () => {
    const node = graphSchema.parse({
      id: "x",
      name: "X",
      nodes: [{ id: "a", label: "A", prompt: "Tu was: {{input}}" }],
      edges: [{ from: "__start__", to: "a" }],
    }).nodes[0]!;
    expect(composeNodePrompt(node, state)).toBe("Tu was: TASK");
  });

  it("puts the skill directive before the task", () => {
    const node = graphSchema.parse({
      id: "x",
      name: "X",
      nodes: [
        {
          id: "a",
          label: "A",
          prompt: "Review this: {{input}}",
          skills: ["code-review"],
        },
      ],
      edges: [{ from: "__start__", to: "a" }],
    }).nodes[0]!;
    const composed = composeNodePrompt(node, state);
    expect(composed.indexOf("code-review")).toBeLessThan(
      composed.indexOf("Review this"),
    );
    expect(composed).toContain("`code-review`");
  });

  it("names several skills in one directive", () => {
    const node = graphSchema.parse({
      id: "x",
      name: "X",
      nodes: [
        { id: "a", label: "A", prompt: "", skills: ["code-review", "tdd"] },
      ],
      edges: [{ from: "__start__", to: "a" }],
    }).nodes[0]!;
    const composed = composeNodePrompt(node, state);
    expect(composed).toContain("`code-review`");
    expect(composed).toContain("`tdd`");
    // No stray blank body when the prompt is empty.
    expect(composed.trim()).toBe(composed);
  });

  it("survives the file round-trip", () => {
    const graph = graphSchema.parse({
      id: "with-skill",
      name: "With Skill",
      nodes: [{ id: "a", label: "A", prompt: "x", skills: ["code-review"] }],
      edges: [
        { from: "__start__", to: "a" },
        { from: "a", to: "__end__" },
      ],
    });
    expect(fromGraphFile(toGraphFile(graph)).nodes[0]!.skills).toEqual([
      "code-review",
    ]);
  });
});

/**
 * The export omits everything the schema fills in anyway. The round-trip tests
 * above already guard the important half — a graph must survive the trip
 * unchanged — so these pin down the other half: that the omission actually
 * happens, and that it never eats something load-bearing.
 */
describe("graph file without defaults", () => {
  const file = (id: string) => JSON.parse(toGraphFile(templateById(id)!));

  it("omits values that equal the schema default", () => {
    const node = file("routing").graph.nodes[0];
    // Every one of these would be written out verbatim before, and all of them
    // are what a fresh node has anyway.
    expect(node).not.toHaveProperty("providerId");
    expect(node).not.toHaveProperty("model");
    expect(node).not.toHaveProperty("maxAttempts");
    expect(node).not.toHaveProperty("skills");
  });

  it("keeps identity even when it would look like a default", () => {
    const graph = file("routing").graph;
    expect(graph.id).toBe("routing");
    expect(graph.nodes[0].id).toBeTruthy();
    expect(graph.nodes[0].label).toBeTruthy();
    expect(graph.edges[0].from).toBeTruthy();
    expect(graph.edges[0].to).toBeTruthy();
  });

  // The negative case: an explicit value that happens to be interesting must
  // survive. A node running on its own model is exactly what a reader of the
  // file needs to see.
  it("keeps an explicit model, a condition and declared fields", () => {
    const source = {
      ...templateById("routing")!,
      nodes: templateById("routing")!.nodes.map((node, index) =>
        index === 0
          ? { ...node, providerId: "claude-code", model: "claude-opus-5" }
          : node,
      ),
    };
    const written = JSON.parse(toGraphFile(source));
    expect(written.graph.nodes[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5",
    });
    // Conditions are the whole point of the graph; none may be dropped.
    const routed = written.graph.edges.filter(
      (edge: { when?: unknown }) => edge.when,
    );
    expect(routed.length).toBeGreaterThan(0);
    expect(fromGraphFile(toGraphFile(source)).nodes[0]!.model).toBe("claude-opus-5");
  });

  it("is materially shorter than the full form", () => {
    const graph = templateById("idea-to-concept")!;
    const compact = toGraphFile(graph).split("\n").length;
    const full = `${JSON.stringify({ version: 1, graph }, null, 2)}\n`.split("\n").length;
    expect(compact).toBeLessThan(full * 0.8);
  });
});
