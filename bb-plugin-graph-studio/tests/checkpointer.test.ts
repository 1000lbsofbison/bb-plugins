// The checkpointer against a real SQLite database.
//
// Durability is the whole claim of this file: a run interrupted mid-graph must
// come back at the same position after the plugin reloads. The test proves it
// by throwing away the compiled graph and rebuilding it from the database.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Command } from "@langchain/langgraph";
import { SqliteCheckpointer } from "../lib/checkpointer";
import { MIGRATIONS } from "../lib/store";
import { END_NODE, START_NODE, emptyRunState, graphSchema } from "../lib/graph";
import { compileGraph, type RuntimeHost } from "../lib/runtime";

function freshDb() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return db;
}

const gateGraph = graphSchema.parse({
  id: "gate",
  name: "Gate",
  nodes: [
    { id: "work", label: "Work", prompt: "w" },
    { id: "ok", label: "Freigabe", kind: "human", prompt: "Freigeben?" },
    { id: "after", label: "Danach", prompt: "a" },
  ],
  edges: [
    { from: START_NODE, to: "work" },
    { from: "work", to: "ok" },
    { from: "ok", to: "after" },
    { from: "after", to: END_NODE },
  ],
});

function host(spawned: string[]): RuntimeHost {
  return {
    async spawn({ nodeId }) {
      spawned.push(nodeId);
      return `thr_${nodeId}`;
    },
    async awaitThread(threadId) {
      return `output of ${threadId}`;
    },
    async onNodeStart() {
      return "node-run";
    },
    async onNodeThread() {},
    async onNodeFinish() {},
    async onStateChange() {},
    log() {},
  };
}

describe("SqliteCheckpointer", () => {
  it("round-trips a checkpoint", async () => {
    const db = freshDb();
    const saver = new SqliteCheckpointer(db);
    const config = { configurable: { thread_id: "r1", checkpoint_ns: "" } };

    expect(await saver.getTuple(config)).toBeUndefined();

    const checkpoint = {
      v: 4,
      id: "0001",
      ts: new Date().toISOString(),
      channel_values: { answer: 42 },
      channel_versions: {},
      versions_seen: {},
    } as never;
    const next = await saver.put(config, checkpoint, { source: "input" } as never, {});
    expect(next.configurable?.checkpoint_id).toBe("0001");

    const tuple = await saver.getTuple(config);
    expect(tuple?.checkpoint.id).toBe("0001");
    expect((tuple?.checkpoint.channel_values as { answer: number }).answer).toBe(42);
  });

  it("stores pending writes alongside their checkpoint", async () => {
    const db = freshDb();
    const saver = new SqliteCheckpointer(db);
    const base = { configurable: { thread_id: "r2", checkpoint_ns: "" } };
    const checkpoint = {
      v: 4,
      id: "0001",
      ts: new Date().toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    } as never;
    await saver.put(base, checkpoint, { source: "input" } as never, {});
    await saver.putWrites(
      { configurable: { ...base.configurable, checkpoint_id: "0001" } },
      [["outputs", { a: "A" }]],
      "task-1",
    );
    const tuple = await saver.getTuple(base);
    expect(tuple?.pendingWrites?.[0]?.[1]).toBe("outputs");
  });

  it("deletes a thread's checkpoints", async () => {
    const db = freshDb();
    const saver = new SqliteCheckpointer(db);
    const config = { configurable: { thread_id: "r3", checkpoint_ns: "" } };
    await saver.put(
      config,
      {
        v: 4,
        id: "0001",
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      } as never,
      { source: "input" } as never,
      {},
    );
    await saver.deleteThread("r3");
    expect(await saver.getTuple(config)).toBeUndefined();
  });

  it("re-runs from an earlier checkpoint without repeating finished nodes", async () => {
    // #3 time travel: pick the point where a node was still pending and
    // continue from there. Earlier nodes must come back from the checkpoint.
    const graph = graphSchema.parse({
      id: "chain",
      name: "Chain",
      nodes: [
        { id: "a", label: "A", prompt: "a", maxAttempts: 1 },
        { id: "b", label: "B", prompt: "b", maxAttempts: 1 },
        { id: "c", label: "C", prompt: "c", maxAttempts: 1 },
      ],
      edges: [
        { from: START_NODE, to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: END_NODE },
      ],
    });
    const db = freshDb();
    const config = { configurable: { thread_id: "run_tt" }, recursionLimit: 50 };

    const first: string[] = [];
    const app = compileGraph(graph, host(first), new SqliteCheckpointer(db));
    await app.invoke(emptyRunState("TASK"), config);
    expect(first).toEqual(["a", "b", "c"]);

    // Find the checkpoint where "c" had not run yet.
    let target: string | undefined;
    for await (const snapshot of app.getStateHistory({
      configurable: { thread_id: "run_tt" },
    })) {
      if ([...snapshot.next].includes("c")) {
        target = snapshot.config.configurable?.checkpoint_id as string;
        break;
      }
    }
    expect(target).toBeTruthy();

    const second: string[] = [];
    const replay = compileGraph(graph, host(second), new SqliteCheckpointer(db));
    const out = (await replay.invoke(null, {
      configurable: { thread_id: "run_tt", checkpoint_id: target },
      recursionLimit: 50,
    })) as { outputs: Record<string, string> };

    // Only "c" runs again; "a" and "b" come back from the checkpoint.
    expect(second).toEqual(["c"]);
    expect(out.outputs.a).toBe("output of thr_a");
    expect(out.outputs.c).toBe("output of thr_c");
  });

  it("resumes an interrupted run from the database after a reload", async () => {
    const db = freshDb();
    const config = { configurable: { thread_id: "run_x" }, recursionLimit: 50 };

    // First "process": run until the human gate, then throw the graph away.
    const firstSpawns: string[] = [];
    const first = compileGraph(
      gateGraph,
      host(firstSpawns),
      new SqliteCheckpointer(db),
    );
    await first.invoke(emptyRunState("TASK"), config);
    expect(firstSpawns).toEqual(["work"]);

    // Second "process": a brand-new checkpointer over the same database.
    const secondSpawns: string[] = [];
    const second = compileGraph(
      gateGraph,
      host(secondSpawns),
      new SqliteCheckpointer(db),
    );
    const state = await second.getState(config);
    expect(state.tasks.flatMap((task) => task.interrupts ?? []).length).toBe(1);

    const out = (await second.invoke(new Command({ resume: "ja" }), config)) as {
      outputs: Record<string, string>;
    };
    // "work" is not re-run: its result came back from the checkpoint.
    expect(secondSpawns).toEqual(["after"]);
    expect(out.outputs.work).toBe("output of thr_work");
    expect(out.outputs.ok).toBe("ja");
  });
});
