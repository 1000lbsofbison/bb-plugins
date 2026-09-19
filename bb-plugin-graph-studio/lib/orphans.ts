// Workers that outlive their run.
//
// A run ends in `failed` or `stopped` between one node and the next, but the
// worker threads it spawned do not know that. An agent worker in a parallel
// branch keeps working towards a result nobody will collect; a dialogue
// worker, idle and waiting for its next answer, asks again and again into a
// run that no longer accepts answers (`answer` refuses with "That run is not
// waiting"). Stopping those threads would be the obvious move — and would
// throw away work that is often the best of the run. So instead the run says
// goodbye: it tells each orphaned worker that the run is over, that no answer
// will arrive, and asks it to write down what it has and stop.
import type { NodeRunRow, RunStatus } from "./store";

export type DialogRow = { nodeId: string; threadId: string };

/**
 * The threads a run still owes a goodbye when it ends, deduplicated.
 *
 * Two sources, because two kinds of worker end up orphaned:
 *
 * - Every `running` node_run with a thread: the branch that did not fail,
 *   still at work while its sibling took the run down. Also the dialogue node
 *   parked at an interrupt when the user stops the run — its row stays open
 *   across replays on purpose.
 * - Every dialogue thread whose node never finished with `done`. A dialogue
 *   thread ends only when the worker answers `done: true`, so a `failed`
 *   dialogue node — a malformed turn, an unanswered question — leaves the
 *   thread sitting idle with a question nobody will answer. A `failed` *agent*
 *   node is different: its thread already reached idle and returned; there is
 *   nobody left in it to tell.
 */
export function orphanedWorkers(
  nodeRuns: NodeRunRow[],
  dialogs: DialogRow[],
): string[] {
  const threads = new Set<string>();
  const finished = new Set<string>();
  for (const row of nodeRuns) {
    if (!row.childThreadId) continue;
    if (row.status === "running") threads.add(row.childThreadId);
    if (row.status === "done") finished.add(row.childThreadId);
  }
  for (const dialog of dialogs) {
    if (!finished.has(dialog.threadId)) threads.add(dialog.threadId);
  }
  return [...threads];
}

/**
 * What an orphaned worker is told. In English like every other prompt the
 * worker sees, and explicit about the one thing it cannot know: nobody is
 * listening any more. The message asks for a final write-up rather than
 * silence, because that write-up is the reason the thread was not simply
 * killed.
 */
export function farewellMessage(
  status: Extract<RunStatus, "failed" | "stopped">,
  error: string | null,
): string {
  const ending =
    status === "stopped"
      ? "The graph run this thread belongs to was stopped."
      : `The graph run this thread belongs to has failed${
          error ? `: ${error}` : "."
        }`;
  return [
    ending,
    "Nobody is reading your questions any more and no further answer will arrive, so do not ask anything else and do not wait for a reply.",
    "If you have findings worth keeping, write them down now as one final message — this thread stays readable — and then stop.",
  ].join(" ");
}
