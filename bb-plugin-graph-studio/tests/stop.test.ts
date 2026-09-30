// The stop path, driven end to end against the fake plugin host.
//
// The runtime tests cover what a GuardStop does to a node; these here cover
// what a stop click does to a run — and the incident they guard for is the
// one that started this: a stop click that visibly did nothing while the
// workers kept working. A stop must be *felt*: the status says `stopping`
// the moment it was asked for, the workers in flight are interrupted, and
// the waits holding the nodes are aborted. And it must *survive*: a plugin
// reload honours a stop that was requested but not finished, instead of
// resurrecting the run.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import graphStudio from "../server";
import { END_NODE, START_NODE, graphSchema } from "../lib/graph";

/** Hosts to dispose of, whatever the assertions decided. */
const open: FakePluginHost[] = [];

afterEach(async () => {
  await Promise.allSettled(
    open.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

/** A one-agent graph: one worker to spawn, one wait to hold. */
const singleAgent = (id: string) =>
  graphSchema.parse({
    id,
    name: "Single Agent",
    nodes: [{ id: "work", label: "Work", prompt: "Work on: {{input}}" }],
    edges: [
      { from: START_NODE, to: "work" },
      { from: "work", to: END_NODE },
    ],
  });

/** A one-human-node graph: the run parks at a question. */
const humanGate = graphSchema.parse({
  id: "human-gate",
  name: "Human Gate",
  nodes: [{ id: "gate", label: "Gate", kind: "human", prompt: "Approve?" }],
  edges: [
    { from: START_NODE, to: "gate" },
    { from: "gate", to: END_NODE },
  ],
});

/**
 * The `bb.sdk` surface a run touches, with the one interesting part left to
 * the caller: `threads.wait`. Everything else is a static answer, because
 * none of it is what these tests are about.
 */
function sdkStubs(wait: (args: { signal?: AbortSignal }) => Promise<unknown>) {
  return {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({
        id: threadId,
        environmentId: "env-1",
        projectId: null,
        providerId: "pi",
      }),
      spawn: async () => ({ id: "thr_worker_1" }),
      wait,
      output: async () => ({ output: "the worker's final answer" }),
      stop: async () => ({ ok: true }),
      send: async () => ({ ok: true }),
      events: { list: async () => [] },
    },
  };
}

/** Load the plugin on a fresh host and return the run of the first graph. */
async function startRun(
  host: FakePluginHost,
  graph: ReturnType<typeof graphSchema.parse>,
) {
  await host.harness.behavior.callRpc("saveGraph", { graph });
  const started = (await host.harness.behavior.callRpc("startRun", {
    graphId: graph.id,
    input: "the task",
    threadId: "thr_parent",
    projectId: null,
  })) as { run: { id: string } };
  return started.run.id;
}

async function statusOf(host: FakePluginHost, runId: string) {
  const result = (await host.harness.behavior.callRpc("getRun", {
    id: runId,
  })) as { run: { status: string } };
  return result.run.status;
}

/** Poll until the run's status is the expected one; fails the test on timeout. */
async function waitForStatus(
  host: FakePluginHost,
  runId: string,
  status: string,
) {
  await vi.waitFor(async () => {
    expect(await statusOf(host, runId)).toBe(status);
  });
}

describe("stopping a run", () => {
  it("marks the run stopping at once, interrupts the worker, and settles it stopped", async () => {
    // The wait is ours to release: the stop has to land while the node still
    // hangs on its worker — the exact situation of the incident.
    let releaseWait: (() => void) | null = null;
    const host = createFakePluginHost({
      pluginId: "graph-studio",
      sdk: sdkStubs(
        () =>
          new Promise((resolve) => {
            releaseWait = resolve;
          }),
      ),
    });
    open.push(host);
    graphStudio(host.bb);

    const runId = await startRun(host, singleAgent("stop-1"));
    await vi.waitFor(async () => {
      const result = (await host.harness.behavior.callRpc("getRun", {
        id: runId,
      })) as { run: { nodeRuns: Array<{ childThreadId: string | null }> } };
      expect(result.run.nodeRuns[0]?.childThreadId).toBe("thr_worker_1");
    });

    const stopped = (await host.harness.behavior.callRpc("stopRun", {
      runId,
    })) as { run: { status: string } };
    // Felt immediately, not once the workers got around to finishing.
    expect(stopped.run.status).toBe("stopping");
    // The worker in flight was interrupted rather than waited out.
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_worker_1" }],
    ]);

    releaseWait!();
    await waitForStatus(host, runId, "stopped");

    const result = (await host.harness.behavior.callRpc("getRun", {
      id: runId,
    })) as {
      run: {
        status: string;
        error: string | null;
        nodeRuns: Array<{ status: string; error: string | null }>;
      };
    };
    expect(result.run.error).toBe("The run was stopped.");
    expect(result.run.nodeRuns[0]).toMatchObject({
      status: "failed",
      error: "The run was stopped.",
    });
  });

  it("aborts the wait of a worker that ignores being interrupted", async () => {
    // The pathological worker: neither the wait nor the thread reacts to the
    // stop. The aborted signal is what still ends the node — a stop must not
    // hide behind the six-hour ceiling of the wait.
    const host = createFakePluginHost({
      pluginId: "graph-studio",
      sdk: sdkStubs(
        (args) =>
          new Promise((_resolve, reject) => {
            const signal = args.signal;
            if (signal?.aborted) {
              reject(new Error("The operation was aborted"));
              return;
            }
            signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted")),
            );
          }),
      ),
    });
    open.push(host);
    graphStudio(host.bb);

    const runId = await startRun(host, singleAgent("stop-2"));
    await vi.waitFor(async () => {
      const result = (await host.harness.behavior.callRpc("getRun", {
        id: runId,
      })) as { run: { nodeRuns: Array<{ childThreadId: string | null }> } };
      expect(result.run.nodeRuns[0]?.childThreadId).toBe("thr_worker_1");
    });

    const stopped = (await host.harness.behavior.callRpc("stopRun", {
      runId,
    })) as { run: { status: string } };
    expect(stopped.run.status).toBe("stopping");

    // No wait to release here: the abort alone has to carry the run to
    // `stopped`, and quickly — no six-hour hostage.
    await waitForStatus(host, runId, "stopped");
    const result = (await host.harness.behavior.callRpc("getRun", {
      id: runId,
    })) as { run: { error: string | null } };
    expect(result.run.error).toBe("The run was stopped.");
  });

  it("settles a run waiting for a human without a detour", async () => {
    const host = createFakePluginHost({
      pluginId: "graph-studio",
      sdk: sdkStubs(async () => ({})),
    });
    open.push(host);
    graphStudio(host.bb);

    const runId = await startRun(host, humanGate);
    await waitForStatus(host, runId, "waiting-human");

    const stopped = (await host.harness.behavior.callRpc("stopRun", {
      runId,
    })) as { run: { status: string; error: string | null } };
    expect(stopped.run.status).toBe("stopped");
    expect(stopped.run.error).toBeNull();
  });
});

describe("a stop across a reload", () => {
  it("honours a requested stop instead of resurrecting the run", async () => {
    // A worker that ignores both the interrupt and the abort: the drive loop
    // hangs, the run stays `stopping` — and the plugin goes down exactly
    // there. What comes back after the reload must not resume that run; it
    // must settle it as stopped and interrupt what survived.
    const host = createFakePluginHost({
      pluginId: "graph-studio",
      sdk: sdkStubs(() => new Promise(() => {})),
    });
    graphStudio(host.bb);

    const runId = await startRun(host, singleAgent("stop-3"));
    await vi.waitFor(async () => {
      const result = (await host.harness.behavior.callRpc("getRun", {
        id: runId,
      })) as { run: { nodeRuns: Array<{ childThreadId: string | null }> } };
      expect(result.run.nodeRuns[0]?.childThreadId).toBe("thr_worker_1");
    });

    const stopped = (await host.harness.behavior.callRpc("stopRun", {
      runId,
    })) as { run: { status: string } };
    expect(stopped.run.status).toBe("stopping");

    // The reload: same database, same plugin, fresh handles. The service
    // runs deterministically below rather than on a timer.
    const next = await host.harness.lifecycle.reload(graphStudio);
    open.push(next);
    next.harness.inspection.sdk.stub("threads.stop", async () => ({ ok: true }));
    next.harness.inspection.sdk.stub("threads.send", async () => ({ ok: true }));

    const service = next.harness.behavior.runService("resume-orphans");
    await waitForStatus(next, runId, "stopped");
    service.controller.abort();
    await service.done;

    // The worker that survived the reload was interrupted, not resumed.
    expect(next.harness.inspection.sdk.callsTo("threads.stop")).toEqual([
      [{ threadId: "thr_worker_1" }],
    ]);
    // It was also told the run is over — the orphan goodbye, sent by the
    // settle, not by a resumed run.
    const sends = next.harness.inspection.sdk.callsTo("threads.send");
    expect(sends.length).toBeGreaterThan(0);
    const text = (sends[0]![0] as { input: Array<{ text: string }> }).input[0]!
      .text;
    expect(text).toContain("was stopped");
  });
});
