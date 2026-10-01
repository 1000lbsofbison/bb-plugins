// BBP-20: a driver that takes a run over re-attaches to the previous driver's
// still-living agent worker instead of spawning the node a second time. Only
// a worker that is really lost gets the node run again — exactly once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import graphStudio from "../server";
import { END_NODE, START_NODE, graphSchema } from "../lib/graph";
import { createStore } from "../lib/store";

const agentGraph = graphSchema.parse({
  id: "one-agent",
  name: "One agent",
  nodes: [{ id: "work", label: "Work", prompt: "{{input}}", maxAttempts: 1 }],
  edges: [
    { from: START_NODE, to: "work" },
    { from: "work", to: END_NODE },
  ],
});

type Worker = {
  status: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
  missing?: boolean;
  output: string;
  /** Resolves every pending and later `wait({status: "idle"})` on it. */
  finish: () => void;
  done: Promise<void>;
};

/**
 * One SDK shared by the predecessor and its successor, like the real host.
 * `wait` deliberately ignores the abort signal, so the predecessor's wait
 * resolves too when the worker finishes — the test then proves that the
 * predecessor still does not consume the result.
 */
function world() {
  const workers = new Map<string, Worker>();
  let spawned = 0;
  const worker = (id: string): Worker => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const entry: Worker = { status: "active", output: "", finish, done };
    workers.set(id, entry);
    return entry;
  };
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        const entry = workers.get(threadId);
        if (entry?.missing) throw new Error(`Thread ${threadId} not found`);
        return {
          id: threadId,
          environmentId: "env-1",
          projectId: "p",
          providerId: "pi",
          status: entry?.status ?? "idle",
          archivedAt: entry?.archivedAt ?? null,
          deletedAt: entry?.deletedAt ?? null,
        };
      },
      spawn: async () => {
        spawned += 1;
        const id = `thr_worker_${spawned}`;
        worker(id);
        return { id };
      },
      wait: async ({ threadId, status }: { threadId: string; status: string }) => {
        if (status !== "idle") return {};
        await workers.get(threadId)?.done;
        return {};
      },
      output: async ({ threadId }: { threadId: string }) => ({
        output: workers.get(threadId)?.output ?? "",
      }),
      stop: async () => ({ ok: true }),
      send: async () => ({ ok: true }),
      events: { list: async () => [] },
    },
    providers: { models: async () => ({ providers: [{ id: "pi", available: true }], models: [] }) },
  };
  return { sdk, workers, spawned: () => spawned };
}

const open: FakePluginHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(open.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

type RunDto = {
  status: string;
  state: { outputs: Record<string, string> };
  nodeRuns: Array<{ status: string; error: string | null; childThreadId: string | null; output: string | null }>;
};

/** Start a run in a first instance, then reload to a successor that sweeps. */
async function takeover(
  w: ReturnType<typeof world>,
  before: (worker: Worker) => void,
  beforeReload?: () => void,
) {
  const first = createFakePluginHost({ pluginId: "graph-studio", sdk: w.sdk as never });
  open.push(first);
  graphStudio(first.bb);
  await first.harness.behavior.callRpc("saveGraph", { graph: agentGraph });
  const started = (await first.harness.behavior.callRpc("startRun", {
    graphId: agentGraph.id,
    input: "task",
    threadId: "thr_parent",
    projectId: null,
  })) as { run: { id: string } };
  await vi.waitFor(() => expect(w.spawned()).toBe(1));
  await vi.waitFor(() =>
    expect(
      createStore(first.bb.storage.database()).listNodeRuns(started.run.id)[0]?.childThreadId,
    ).toBe("thr_worker_1"),
  );
  before(w.workers.get("thr_worker_1")!);
  beforeReload?.();
  const next = await first.harness.lifecycle.reload(graphStudio);
  open.push(next);
  const sweep = next.harness.behavior.runService("resume-orphans");
  const run = async () =>
    ((await next.harness.behavior.callRpc("getRun", { id: started.run.id })) as { run: RunDto }).run;
  return { first, next, sweep, run, runId: started.run.id };
}

describe("takeover of a run with an agent node in flight", () => {
  it("re-attaches to a still-running worker: no spawn, its answer, no Abandoned row", async () => {
    const w = world();
    const t = await takeover(w, () => {});
    // The successor took the run and is waiting on the old worker.
    await vi.waitFor(() =>
      expect(createStore(t.next.bb.storage.database()).getDriver(t.runId)?.driverId).toMatch(/^drv_/),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(w.spawned()).toBe(1);
    expect((await t.run()).status).toBe("running");
    const worker = w.workers.get("thr_worker_1")!;
    worker.output = "answer of the old worker";
    worker.status = "idle";
    worker.finish();
    await vi.waitFor(async () => expect((await t.run()).status).toBe("done"));
    const run = await t.run();
    expect(w.spawned()).toBe(1);
    expect(run.state.outputs.work).toBe("answer of the old worker");
    expect(run.nodeRuns).toHaveLength(1);
    expect(run.nodeRuns[0]).toMatchObject({ status: "done", childThreadId: "thr_worker_1", error: null });
    expect(t.next.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    t.sweep.controller.abort();
  });

  it("takes the result of a worker that finished while nobody was driving", async () => {
    const w = world();
    const t = await takeover(w, (worker) => {
      // Finished during the reload gap, before the successor looked. The
      // predecessor's own wait resolves too, but it no longer drives the run.
      worker.output = "finished meanwhile";
      worker.status = "idle";
      worker.finish();
    });
    await vi.waitFor(async () => expect((await t.run()).status).toBe("done"));
    const run = await t.run();
    expect(w.spawned()).toBe(1);
    expect(run.state.outputs.work).toBe("finished meanwhile");
    expect(run.nodeRuns.map((row) => row.status)).toEqual(["done"]);
    t.sweep.controller.abort();
  });

  it("keeps the claim with heartbeats while it waits on the adopted worker", async () => {
    const w = world();
    // Fake intervals before the successor loads, so its heartbeat timer is one.
    const t = await takeover(w, () => {}, () =>
      vi.useFakeTimers({ toFake: ["setInterval", "Date"] }),
    );
    const store = createStore(t.next.bb.storage.database());
    await vi.advanceTimersByTimeAsync(1_000);
    const before = store.getDriver(t.runId)!;
    expect(before.driverId).toMatch(/^drv_/);
    // Longer than the 60 s expiry: only renewal keeps the claim fresh.
    await vi.advanceTimersByTimeAsync(70_000);
    const after = store.getDriver(t.runId)!;
    const now = Date.now();
    vi.useRealTimers();
    expect(after.driverId).toBe(before.driverId);
    expect(after.heartbeatAt!).toBeGreaterThan(before.heartbeatAt!);
    expect(now - after.heartbeatAt!).toBeLessThan(60_000);
    expect(w.spawned()).toBe(1);
    expect((await t.run()).status).toBe("running");
    t.sweep.controller.abort();
  });

  const lostCases: Array<[string, (worker: Worker) => void, string]> = [
    ["missing", (worker) => (worker.missing = true), "missing"],
    ["errored", (worker) => (worker.status = "error"), "is error"],
    ["archived", (worker) => (worker.archivedAt = 1), "archived"],
    ["deleted", (worker) => (worker.deletedAt = 1), "deleted"],
    ["idle without a result", (worker) => (worker.status = "idle"), "without a result"],
  ];
  for (const [name, breakIt, reason] of lostCases) {
    it(`spawns exactly once anew for a lost worker (${name})`, async () => {
      const w = world();
      const t = await takeover(w, breakIt);
      await vi.waitFor(() => expect(w.spawned()).toBe(2));
      const fresh = w.workers.get("thr_worker_2")!;
      fresh.output = "fresh answer";
      fresh.status = "idle";
      fresh.finish();
      await vi.waitFor(async () => expect((await t.run()).status).toBe("done"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(w.spawned()).toBe(2);
      const run = await t.run();
      expect(run.state.outputs.work).toBe("fresh answer");
      const failed = run.nodeRuns.filter((row) => row.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.error).toContain("Abandoned");
      expect(failed[0]!.error).toContain(reason);
      expect(run.nodeRuns.filter((row) => row.status === "done").map((row) => row.childThreadId)).toEqual([
        "thr_worker_2",
      ]);
      t.sweep.controller.abort();
    });
  }
});
