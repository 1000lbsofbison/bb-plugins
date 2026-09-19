// What a bulk delete actually removes — as pure functions, without SDK.
//
// Background: bb 0.43.1 deletes the addressed thread ONLY. Its children survive
// with `parent_thread_id` set to NULL and reappear as roots of their own (see
// `visibleRootOf` in lib/tree.ts). `childThreadsConfirmed: true` is a
// confirmation receipt, not a cascade. Deleting a family therefore means
// addressing every member ourselves — which is the whole point of the selection
// mode.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export interface DeletionPlan {
  /** The picked threads, minus any whose ancestor was picked as well. */
  chosen: string[];
  /** Threads that go down with them without having been picked. */
  alsoDeleted: string[];
}

/**
 * What the user is about to destroy, spelled out before they confirm.
 *
 * Only what the sidenav can see goes into this preview — archived or hidden
 * children are not in `threads`, so the server walks the real tree again before
 * it deletes. The preview is therefore a lower bound, never a promise.
 */
export function planDeletion(
  threads: readonly PluginSidebarThread[],
  selected: ReadonlySet<string>,
): DeletionPlan {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const covered = (id: string): boolean => {
    const seen = new Set([id]);
    let parent = byId.get(id)?.parentThreadId ?? null;
    while (parent !== null && !seen.has(parent)) {
      if (selected.has(parent)) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parentThreadId ?? null;
    }
    return false;
  };

  const chosen = [...selected].filter((id) => byId.has(id) && !covered(id));
  const chosenSet = new Set(chosen);
  const alsoDeleted = threads
    .filter((thread) => !selected.has(thread.id))
    .filter((thread) => {
      const seen = new Set([thread.id]);
      let parent = thread.parentThreadId;
      while (parent !== null && !seen.has(parent)) {
        if (chosenSet.has(parent)) return true;
        seen.add(parent);
        parent = byId.get(parent)?.parentThreadId ?? null;
      }
      return false;
    })
    .map((thread) => thread.id);

  return { chosen, alsoDeleted };
}

/**
 * Every thread that must be addressed, children before their parents.
 *
 * Deepest first because a parent deleted early would orphan its children: they
 * would become roots and the second call would still find them, but the list
 * would flicker through a state nobody asked for. `listChildren` is injected so
 * this is testable without a host.
 */
export async function collectFamilies(
  rootIds: readonly string[],
  listChildren: (threadId: string) => Promise<readonly string[]>,
): Promise<string[]> {
  const ordered: string[] = [];
  const seen = new Set<string>();

  async function walk(id: string): Promise<void> {
    // A cycle in `parent_thread_id` must not spin forever — the host does not
    // promise a tree, only a column.
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of await listChildren(id)) await walk(child);
    ordered.push(id);
  }

  for (const id of rootIds) await walk(id);
  return ordered;
}
