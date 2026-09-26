// Writing goes through `bb tasks update`, never through SQL.
//
// The database file is right there and opening it for writing would be a few
// lines. It is still the wrong call: the `tasks` plugin's invariants live in
// its own code — the revision triggers, the UNIQUE (project_id, number)
// numbering, whatever a future migration adds — and writing behind them means
// reimplementing them and keeping the copy correct forever. The CLI already
// holds those rules.
//
// The argv builder is separated from the spawn so the shape of the command can
// be tested without a BB installation.
import { execFile } from "node:child_process";
import type { LaneStatus } from "./columns";

/**
 * A task key such as `ABC-12`, which is what `bb tasks update` takes as its
 * positional argument. Validated rather than trusted: the value crosses the RPC
 * boundary from the frontend, and it becomes an argv entry.
 */
const TASK_KEY = /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/;

export function isTaskKey(value: string): boolean {
  return TASK_KEY.test(value);
}

export function buildUpdateStatusArgs(
  taskKey: string,
  status: LaneStatus,
): string[] {
  if (!isTaskKey(taskKey)) {
    throw new Error(`Not a task key: ${taskKey}`);
  }
  return ["tasks", "update", taskKey, "--status", status, "--json"];
}

export type CliRunner = (args: string[]) => Promise<string>;

/**
 * `execFile`, not a shell: the arguments carry a user-chosen task key, and an
 * argv array cannot be talked into being two commands.
 *
 * `BB_CLI` is honoured because BB sets it for the binary that belongs to the
 * running server; falling back to `bb` on PATH would otherwise reach a
 * different installation than the one whose database we just read.
 */
export const runBbCli: CliRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.BB_CLI ?? "bb",
      args,
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // stderr carries the CLI's own message ("no such task ..."), which is
          // more use to the user than "exited with code 1".
          const detail = stderr.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      },
    );
  });
