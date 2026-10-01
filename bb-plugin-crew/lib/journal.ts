// The journal (`member_ops`): every thread-creating step writes its intent
// before it calls BB and its result after. The SDK has no idempotency key for
// `threads.spawn`, so a crash between the two would otherwise leave a thread
// nobody knows about and the next apply would spawn a second one. The opId
// travels into the thread's plugin metadata at spawn time, which is what lets
// `recoverOrphan` find it again.
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { ThreadInfo, ThreadPort } from "./thread-port";

export type Journal = ReturnType<typeof createJournal>;

export function createJournal(store: Store, newId: () => string = randomUUID) {
  return {
    begin(memberRow: string, kind: "spawn" | "reset" | "attach" | "handover"): string {
      const opId = newId();
      store.insertOp({ opId, memberId: memberRow, kind });
      return opId;
    },
    done(opId: string, threadId: string): void {
      store.finishOp(opId, "done", threadId, null);
    },
    failed(opId: string, error: string, threadId: string | null = null): void {
      store.finishOp(opId, "failed", threadId, error);
    },
    open(memberRow: string) {
      return store.openOps(memberRow);
    },
    /**
     * Look for a thread spawned by one of the member's unfinished intents.
     * Found → the intent is closed as done with that thread. Not found → the
     * intent is closed as failed, because the spawn never reached BB.
     */
    async recoverOrphan(
      memberRow: string,
      projectId: string,
      port: ThreadPort,
    ): Promise<{ thread: ThreadInfo; opId: string } | null> {
      const intents = store.openOps(memberRow);
      if (intents.length === 0) return null;
      const wanted = new Set(intents.map((op) => op.opId));
      let found: { thread: ThreadInfo; opId: string } | null = null;
      for (const thread of await port.listOwn(projectId)) {
        const metadata = await port.metadata(thread.id).catch(() => ({}) as Record<string, unknown>);
        const opId = metadata.opId;
        if (typeof opId === "string" && wanted.has(opId)) {
          found = { thread, opId };
          break;
        }
      }
      for (const op of intents) {
        if (found && op.opId === found.opId) store.finishOp(op.opId, "done", found.thread.id, null);
        else store.finishOp(op.opId, "failed", null, "no thread found for this intent");
      }
      return found;
    },
  };
}
