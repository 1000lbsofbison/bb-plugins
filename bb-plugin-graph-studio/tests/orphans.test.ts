// Who gets told that a run ended, and what they are told. The bug this guards
// (STATUS.md, error 10): a run failed, its dialogue worker kept asking
// questions into a run that no longer accepted answers, and nobody told it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  farewellMessage,
  interruptibleWorkers,
  orphanedWorkers,
} from "../lib/orphans";
import type { NodeRunRow } from "../lib/store";

function nodeRun(
  nodeId: string,
  status: NodeRunRow["status"],
  childThreadId: string | null,
): NodeRunRow {
  return {
    id: `nr_${nodeId}_${status}`,
    runId: "run_1",
    nodeId,
    attempt: 1,
    status,
    childThreadId,
    output: null,
    error: null,
    startedAt: 0,
    endedAt: null,
    inputTokens: null,
    outputTokens: null,
  };
}

describe("orphanedWorkers", () => {
  it("includes the worker of a node that is still running", () => {
    expect(orphanedWorkers([nodeRun("a", "running", "thr_a")], [])).toEqual([
      "thr_a",
    ]);
  });

  /** The actual incident: the dialogue node failed, its thread sat waiting. */
  it("includes a dialogue thread whose node failed", () => {
    expect(
      orphanedWorkers(
        [nodeRun("talk", "failed", "thr_talk")],
        [{ nodeId: "talk", threadId: "thr_talk" }],
      ),
    ).toEqual(["thr_talk"]);
  });

  it("includes a dialogue thread parked at an interrupt when the run is stopped", () => {
    expect(
      orphanedWorkers(
        [nodeRun("talk", "running", "thr_talk")],
        [{ nodeId: "talk", threadId: "thr_talk" }],
      ),
    ).toEqual(["thr_talk"]);
  });

  it("leaves a finished worker alone", () => {
    expect(orphanedWorkers([nodeRun("a", "done", "thr_a")], [])).toEqual([]);
  });

  /** An agent thread that failed already returned; there is nobody in it. */
  it("leaves the thread of a failed agent node alone", () => {
    expect(orphanedWorkers([nodeRun("a", "failed", "thr_a")], [])).toEqual([]);
  });

  it("leaves a dialogue thread alone once its node finished with done", () => {
    expect(
      orphanedWorkers(
        [nodeRun("talk", "done", "thr_talk")],
        [{ nodeId: "talk", threadId: "thr_talk" }],
      ),
    ).toEqual([]);
  });

  it("skips a running row that has no thread yet", () => {
    expect(orphanedWorkers([nodeRun("a", "running", null)], [])).toEqual([]);
  });

  it("names each thread once, even when both sources report it", () => {
    expect(
      orphanedWorkers(
        [nodeRun("talk", "running", "thr_talk"), nodeRun("b", "running", "thr_b")],
        [{ nodeId: "talk", threadId: "thr_talk" }],
      ),
    ).toEqual(["thr_talk", "thr_b"]);
  });
});

describe("interruptibleWorkers", () => {
  it("names the worker of every running node", () => {
    expect(
      interruptibleWorkers([
        nodeRun("a", "running", "thr_a"),
        nodeRun("b", "running", "thr_b"),
      ]),
    ).toEqual(["thr_a", "thr_b"]);
  });

  /** Finished and failed nodes have no worker mid-turn any more. */
  it("leaves finished and failed attempts alone", () => {
    expect(
      interruptibleWorkers([
        nodeRun("a", "done", "thr_a"),
        nodeRun("b", "failed", "thr_b"),
      ]),
    ).toEqual([]);
  });

  it("skips a running row that has no thread yet", () => {
    expect(interruptibleWorkers([nodeRun("a", "running", null)])).toEqual([]);
  });

  it("names each thread once, however many attempts share it", () => {
    expect(
      interruptibleWorkers([
        nodeRun("a", "running", "thr_a"),
        nodeRun("a2", "running", "thr_a"),
      ]),
    ).toEqual(["thr_a"]);
  });
});

describe("farewellMessage", () => {
  it("names the failure the worker could not see", () => {
    const text = farewellMessage("failed", "Node X returned no result.");
    expect(text).toContain("has failed");
    expect(text).toContain("Node X returned no result.");
  });

  it("says stopped, not failed, when the user stopped the run", () => {
    const text = farewellMessage("stopped", null);
    expect(text).toContain("was stopped");
    expect(text).not.toContain("failed");
  });

  it("tells the worker not to ask again, and to write down what it has", () => {
    const text = farewellMessage("failed", null);
    expect(text).toMatch(/do not ask/i);
    expect(text).toMatch(/final message/i);
  });
});

/**
 * The wiring lives in server.ts, which only runs inside a host. Read against
 * the source like tests/agent-tools.test.ts does: both places where a run
 * ends without a driver must say goodbye, or the fix holds for one exit and
 * the bug returns through the other.
 */
describe("server.ts says goodbye at every exit", () => {
  const source = readFileSync("server.ts", "utf8");

  it("after a run fails or is stopped inside drive", () => {
    const drive = source.slice(
      source.indexOf("async function drive("),
      source.indexOf("function startRun("),
    );
    const catchBlock = drive.slice(drive.indexOf("} catch (cause)"));
    expect(catchBlock).toContain("farewellWorkers(runId, status, message)");
  });

  it("when a run waiting for a human is stopped", () => {
    const stop = source.slice(
      source.indexOf("function requestStop("),
      source.indexOf("async function farewellWorkers("),
    );
    expect(stop).toContain('farewellWorkers(runId, "stopped", null)');
  });

  it("steers a busy worker instead of queueing behind work it should drop", () => {
    const farewell = source.slice(source.indexOf("async function farewellWorkers("));
    expect(farewell).toContain('mode: "steer-if-active"');
  });
});
