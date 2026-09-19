// Persistence for the "create a new graph" path: clone a template under a new
// id, save it, read it back. Templates themselves are shipped code and must
// never end up as stored rows.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, createStore } from "../lib/store";
import { TEMPLATES, templateById } from "../lib/templates";
import { graphSchema, validateGraph } from "../lib/graph";

function freshStore() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return createStore(db);
}

describe("graph library", () => {
  it("starts empty, because templates are code and not rows", () => {
    expect(freshStore().listGraphs()).toEqual([]);
  });

  it("saves a clone of a template under a new id and reads it back", () => {
    const store = freshStore();
    const template = templateById("harness-arc")!;
    const saved = store.saveGraph(
      { ...template, id: "meine-kopie", name: "Meine Kopie", createdAt: 0 },
      1_000,
    );

    expect(saved.id).toBe("meine-kopie");
    expect(saved.createdAt).toBe(1_000);

    const loaded = store.getGraph("meine-kopie");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Meine Kopie");
    expect(loaded!.nodes).toHaveLength(template.nodes.length);
    expect(loaded!.edges).toHaveLength(template.edges.length);
    // The clone must still be runnable, cycle and all.
    expect(validateGraph(loaded!).filter((p) => p.level === "error")).toEqual([]);
    expect(store.listGraphs().map((graph) => graph.id)).toEqual(["meine-kopie"]);
  });

  it("saves a hand-built graph and updates it in place", () => {
    const store = freshStore();
    const graph = graphSchema.parse({
      id: "my-graph",
      name: "My Graph",
      nodes: [{ id: "schritt1", label: "Erster Schritt", prompt: "{{input}}" }],
      edges: [
        { from: "__start__", to: "schritt1" },
        { from: "schritt1", to: "__end__" },
      ],
    });
    store.saveGraph(graph, 1_000);
    store.saveGraph({ ...graph, name: "Umbenannt" }, 2_000);

    const loaded = store.getGraph("my-graph")!;
    expect(loaded.name).toBe("Umbenannt");
    expect(loaded.createdAt).toBe(1_000);
    expect(loaded.updatedAt).toBe(2_000);
    expect(store.listGraphs()).toHaveLength(1);
  });

  it("drops a row that squats on a reserved template id", () => {
    const store = freshStore();
    const template = TEMPLATES[0]!;
    store.saveGraph({ ...template, name: "Stale copy" }, 1_000);
    expect(store.getGraph(template.id)).not.toBeNull();

    // What the factory does on load.
    for (const shipped of TEMPLATES) {
      if (store.getGraph(shipped.id)) store.deleteGraph(shipped.id);
    }
    expect(store.getGraph(template.id)).toBeNull();
    expect(store.listGraphs()).toEqual([]);
  });

  it("deletes a graph", () => {
    const store = freshStore();
    store.saveGraph({ ...templateById("routing")!, id: "gone" }, 1_000);
    store.deleteGraph("gone");
    expect(store.getGraph("gone")).toBeNull();
  });
});

/**
 * Duration and token usage per node run. The whole point of recording these is
 * to make "which model on which node" a decision with a number behind
 * it — so the case that matters is the one where the number is missing. A node
 * whose usage could not be read must stay null and never become 0, because an
 * inspector cannot tell an honest zero from a measurement that never happened.
 */
describe("node run cost", () => {
  const nodeRun = (id: string) => ({
    id,
    runId: "run_1",
    nodeId: "a",
    attempt: 1,
    status: "running" as const,
    childThreadId: null,
    output: null,
    error: null,
    startedAt: 1_000,
    endedAt: null,
    inputTokens: null,
    outputTokens: null,
  });

  it("stores what was measured", () => {
    const store = freshStore();
    store.insertNodeRun(nodeRun("nr_1"));
    store.updateNodeRun("nr_1", {
      status: "done",
      childThreadId: "thr_1",
      output: "fertig",
      error: null,
      endedAt: 4_000,
      inputTokens: 1_200,
      outputTokens: 300,
    });
    const [row] = store.listNodeRuns("run_1");
    expect(row).toMatchObject({ inputTokens: 1_200, outputTokens: 300 });
  });

  it("leaves usage null when the caller reports none", () => {
    const store = freshStore();
    store.insertNodeRun(nodeRun("nr_2"));
    // A finish without usage — an unreadable catalog, a provider that does not
    // report. The row must not claim the node was free.
    store.updateNodeRun("nr_2", {
      status: "done",
      childThreadId: "thr_2",
      output: "fertig",
      error: null,
      endedAt: 4_000,
    });
    const [row] = store.listNodeRuns("run_1");
    expect(row!.inputTokens).toBeNull();
    expect(row!.outputTokens).toBeNull();
  });

  // The migration runs against databases that already hold rows; the added
  // columns must be readable there without a rewrite.
  it("reads pre-existing rows as unmeasured", () => {
    const store = freshStore();
    store.insertNodeRun(nodeRun("nr_3"));
    expect(store.listNodeRuns("run_1")[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
  });
});

describe("dialogs", () => {
  it("lists every dialogue thread a run opened, and only that run's", () => {
    const store = freshStore();
    store.saveDialog("run_1", "talk", 1, { threadId: "thr_1", turns: 0 });
    store.saveDialog("run_1", "talk", 2, { threadId: "thr_2", turns: 3 });
    store.saveDialog("run_2", "talk", 1, { threadId: "thr_other", turns: 0 });

    expect(store.listDialogs("run_1")).toEqual([
      { nodeId: "talk", threadId: "thr_1" },
      { nodeId: "talk", threadId: "thr_2" },
    ]);
  });

  it("is empty for a run without dialogue nodes", () => {
    expect(freshStore().listDialogs("run_x")).toEqual([]);
  });
});
