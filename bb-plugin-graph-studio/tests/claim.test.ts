// BBP-16: one driver per run. A reload, a slow restart or a second sweep of
// resume-orphans must never leave two drivers walking the same run.
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import graphStudio from "../server";
import { END_NODE, START_NODE, graphSchema } from "../lib/graph";
import { MIGRATIONS, createStore } from "../lib/store";

const EXPIRY = 60_000;

/** Two connections to one file: what two processes or instances see. */
function twoStores() {
  const file = join(mkdtempSync(join(tmpdir(), "gs-claim-")), "data.db");
  const first = new Database(file);
  for (const statement of MIGRATIONS) first.exec(statement);
  const a = createStore(first);
  const b = createStore(new Database(file));
  a.insertRun({
    id: "run_1",
    graphId: "g",
    graph: agentGraph,
    threadId: "thr",
    projectId: null,
    input: "",
    status: "running",
    state: {},
    error: null,
    createdAt: 0,
    updatedAt: 0,
  });
  return { a, b };
}

describe("the run claim in the store", () => {
  it("lets exactly one of two drivers take a free run", () => {
    const { a, b } = twoStores();
    const results = [a.claimRun("run_1", "drv_a", 1_000, EXPIRY), b.claimRun("run_1", "drv_b", 1_000, EXPIRY)];
    expect(results).toEqual([true, false]);
    expect(b.getDriver("run_1")).toEqual({ driverId: "drv_a", heartbeatAt: 1_000 });
  });

  it("refuses a live claim (negative) and hands over an expired one (positive)", () => {
    const { a, b } = twoStores();
    expect(a.claimRun("run_1", "drv_a", 1_000, EXPIRY)).toBe(true);
    // Renewed just before the expiry: still the holder's.
    expect(a.heartbeatRun("run_1", "drv_a", 50_000)).toBe(true);
    expect(b.claimRun("run_1", "drv_b", 50_000 + EXPIRY - 1, EXPIRY)).toBe(false);
    // Not renewed for longer than the expiry: the driver is dead.
    expect(b.claimRun("run_1", "drv_b", 50_000 + EXPIRY + 1, EXPIRY)).toBe(true);
    expect(a.getDriver("run_1")?.driverId).toBe("drv_b");
    // The old driver notices on its next heartbeat.
    expect(a.heartbeatRun("run_1", "drv_a", 200_000)).toBe(false);
  });

  it("is re-entrant for its holder and released only by its holder", () => {
    const { a, b } = twoStores();
    expect(a.claimRun("run_1", "drv_a", 1_000, EXPIRY)).toBe(true);
    expect(a.claimRun("run_1", "drv_a", 2_000, EXPIRY)).toBe(true);
    b.releaseRun("run_1", "drv_b");
    expect(a.getDriver("run_1")?.driverId).toBe("drv_a");
    a.releaseRun("run_1", "drv_a");
    expect(b.getDriver("run_1")).toEqual({ driverId: null, heartbeatAt: null });
    expect(b.claimRun("run_1", "drv_b", 3_000, EXPIRY)).toBe(true);
  });
});

const open: FakePluginHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(open.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

const agentGraph = graphSchema.parse({
  id: "one-agent",
  name: "One agent",
  nodes: [{ id: "work", label: "Work", prompt: "{{input}}", maxAttempts: 1 }],
  edges: [
    { from: START_NODE, to: "work" },
    { from: "work", to: END_NODE },
  ],
});

/** A worker that never finishes, so a run stays `running` while we look. */
function load() {
  const host = createFakePluginHost({
    pluginId: "graph-studio",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: "env-1", projectId: "p", providerId: "pi" }),
        spawn: async () => ({ id: "thr_worker" }),
        wait: (_: unknown) => new Promise(() => {}),
        output: async () => ({ output: "x" }),
        stop: async () => ({ ok: true }),
        send: async () => ({ ok: true }),
        events: { list: async () => [] },
      },
      providers: { models: async () => ({ providers: [{ id: "pi", available: true }], models: [] }) },
    } as never,
  });
  open.push(host);
  graphStudio(host.bb);
  return host;
}

/** A `running` row nobody drives: what a crash leaves behind. */
function orphan(host: FakePluginHost, claim?: { driverId: string; heartbeatAt: number }) {
  const db = host.bb.storage.database();
  createStore(db).insertRun({
    id: "run_orphan",
    graphId: agentGraph.id,
    graph: agentGraph,
    threadId: "thr_parent",
    projectId: null,
    input: "task",
    status: "running",
    state: {},
    error: null,
    createdAt: 0,
    updatedAt: 0,
  });
  if (claim) {
    db.prepare(`UPDATE runs SET driver_id = ?, driver_heartbeat_at = ? WHERE id = ?`).run(
      claim.driverId,
      claim.heartbeatAt,
      "run_orphan",
    );
  }
}

const spawns = (host: FakePluginHost) => host.harness.inspection.sdk.callsTo("threads.spawn").length;

describe("resume-orphans with a claim per run", () => {
  it("drives an orphan exactly once when two sweeps race for it", async () => {
    const host = load();
    orphan(host);
    const first = host.harness.behavior.runService("resume-orphans");
    const second = host.harness.behavior.runService("resume-orphans");
    await vi.waitFor(() => expect(spawns(host)).toBe(1));
    // Give a second driver every chance to show up.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(spawns(host)).toBe(1);
    first.controller.abort();
    second.controller.abort();
  });

  it("leaves a run alone while another driver's claim is live (negative)", async () => {
    const host = load();
    orphan(host, { driverId: "drv_elsewhere", heartbeatAt: Date.now() });
    const service = host.harness.behavior.runService("resume-orphans");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(spawns(host)).toBe(0);
    expect(createStore(host.bb.storage.database()).getDriver("run_orphan")?.driverId).toBe("drv_elsewhere");
    service.controller.abort();
  });

  it("takes over a run whose driver's claim expired (positive)", async () => {
    const host = load();
    orphan(host, { driverId: "drv_dead", heartbeatAt: Date.now() - 5 * 60_000 });
    const service = host.harness.behavior.runService("resume-orphans");
    await vi.waitFor(() => expect(spawns(host)).toBe(1));
    expect(createStore(host.bb.storage.database()).getDriver("run_orphan")?.driverId).toMatch(/^drv_/);
    expect(createStore(host.bb.storage.database()).getDriver("run_orphan")?.driverId).not.toBe("drv_dead");
    service.controller.abort();
  });

  it("picks the run up on a later sweep once a live claim expires", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const host = load();
    orphan(host, { driverId: "drv_dying", heartbeatAt: Date.now() });
    const service = host.harness.behavior.runService("resume-orphans");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawns(host)).toBe(0);
    await vi.advanceTimersByTimeAsync(40_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(spawns(host)).toBe(1));
    service.controller.abort();
  });

  it("hands its runs to the successor on reload, which drives them once", async () => {
    const host = load();
    const started = (await host.harness.behavior.callRpc("startRun", {
      graphId: (await host.harness.behavior.callRpc("saveGraph", { graph: agentGraph }), agentGraph.id),
      input: "task",
      threadId: "thr_parent",
      projectId: null,
    })) as { run: { id: string } };
    await vi.waitFor(() => expect(spawns(host)).toBe(1));
    const next = await host.harness.lifecycle.reload(graphStudio);
    open.push(next);
    // The predecessor gave its claim back on dispose.
    expect(createStore(next.bb.storage.database()).getDriver(started.run.id)?.driverId).toBeNull();
    const a = next.harness.behavior.runService("resume-orphans");
    const b = next.harness.behavior.runService("resume-orphans");
    await vi.waitFor(() => expect(spawns(next)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(spawns(next)).toBe(1);
    // The predecessor wrote nothing on its way out; the successor closed the
    // abandoned attempt, interrupted its worker, and runs the node once more.
    const run = (await next.harness.behavior.callRpc("getRun", { id: started.run.id })) as {
      run: { status: string; nodeRuns: Array<{ status: string; error: string | null }> };
    };
    expect(run.run.status).toBe("running");
    expect(run.run.nodeRuns.map((row) => row.status).sort()).toEqual(["failed", "running"]);
    expect(run.run.nodeRuns.find((row) => row.status === "failed")?.error).toContain("Abandoned");
    expect(next.harness.inspection.sdk.callsTo("threads.stop").map((call) => (call[0] as { threadId: string }).threadId)).toEqual(["thr_worker"]);
    a.controller.abort();
    b.controller.abort();
  });
});
