// Waiting for BB to let go of the workspace.
//
// A `reuse` spawn is refused with HTTP 409 / `workspace_busy` while the
// environment still has an `ownerThreadId`. BB clears that owner a moment
// *after* the previous worker reports `idle` — measured at ~500 ms. Since a
// node spawns the next worker as soon as `awaitThread` resolves, every graph
// with two consecutive nodes runs straight into that gap: the first node
// succeeds, the second dies after 3 ms without ever getting a thread.
//
// So the wait belongs here and not in the runtime, which knows nothing about
// BB. Retrying is safe because the refusal happens before a thread exists —
// there is no half-spawned worker to clean up.

/** BB's error for "someone else still holds this workspace". */
export function isWorkspaceBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  if (candidate.status !== 409) return false;
  // The code is the contract; the message is prose and may be reworded.
  return candidate.code === "workspace_busy";
}

export type WorkspaceWaitOptions = {
  /** Give up after this long. Default: two minutes. */
  timeoutMs?: number;
  /** First pause between attempts; doubles up to `maxDelayMs`. */
  delayMs?: number;
  maxDelayMs?: number;
  /** Injected so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called before each retry, so the run log shows why a node is slow. */
  onWait?: (attempt: number, waitedMs: number) => void;
};

/**
 * Run `attempt`, retrying only while BB reports the workspace as busy.
 *
 * Every other failure is rethrown untouched and immediately — a wrong project,
 * a missing environment or a stopped run must not be sat out for two minutes.
 */
export async function whileWorkspaceBusy<T>(
  attempt: () => Promise<T>,
  options: WorkspaceWaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const startedAt = now();
  let delay = options.delayMs ?? 250;
  let tries = 0;

  for (;;) {
    tries += 1;
    try {
      return await attempt();
    } catch (error) {
      if (!isWorkspaceBusy(error)) throw error;
      const waited = now() - startedAt;
      // The budget is checked against the time already spent, so a slow
      // attempt cannot push the total far past `timeoutMs`.
      if (waited + delay > timeoutMs) throw error;
      options.onWait?.(tries, waited);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
