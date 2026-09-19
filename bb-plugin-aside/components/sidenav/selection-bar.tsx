// The bar that appears while threads are selected.
//
// Deleting takes two presses and the second one names a number. There is no
// modal: the bar is already the only thing in the sidenav that talks about the
// selection, so the confirmation belongs in it rather than in a window that
// covers the list you are trying to check.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

/**
 * The sentence above the buttons. Split out because it is the whole safety of
 * this feature: whoever reads "3 threads" and deletes 11 was lied to.
 */
export function deletionSentence(chosen: number, alsoDeleted: number): string {
  const threads = `${chosen} ${chosen === 1 ? "thread" : "threads"}`;
  if (alsoDeleted === 0) return `Delete ${threads}?`;
  const agents = `${alsoDeleted} ${alsoDeleted === 1 ? "agent" : "agents"}`;
  return `Delete ${threads} and ${agents} below them?`;
}

export function SelectionBar({
  selectedCount,
  chosenCount,
  alsoDeletedCount,
  busy,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  chosenCount: number;
  alsoDeletedCount: number;
  busy: boolean;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  // A selection that changes invalidates the number the confirmation showed.
  // Without this, unchecking a thread after pressing Delete would still delete
  // the count you agreed to.
  useEffect(() => setConfirming(false), [selectedCount]);

  if (selectedCount === 0) return null;

  return (
    <div className="shrink-0 border-t border-border-hairline px-3 py-2">
      {confirming ? (
        <div className="flex flex-col gap-2">
          <span className="text-2xs text-muted-foreground">
            {deletionSentence(chosenCount, alsoDeletedCount)} This cannot be undone.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className={cn(
                "rounded-md bg-destructive px-2 py-1 text-2xs text-destructive-foreground",
                "hover:opacity-90 disabled:opacity-50",
              )}
            >
              {busy ? "Deleting …" : "Delete"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="rounded-md px-2 py-1 text-2xs text-muted-foreground hover:bg-sidebar-accent disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
            {selectedCount} selected
          </span>
          <button
            type="button"
            aria-label="Delete selected threads"
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-2xs text-destructive hover:bg-sidebar-accent"
          >
            <Icon name="Trash2" className="size-3.5" aria-hidden />
            Delete
          </button>
          <button
            type="button"
            aria-label="Clear selection"
            onClick={onClear}
            className="rounded-md px-2 py-1 text-2xs text-muted-foreground hover:bg-sidebar-accent"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
