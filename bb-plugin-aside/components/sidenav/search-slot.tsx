// The search slot — one line between the menu bar and the list.
//
// It only appears once you ask for it. A field that is always there costs a row
// of the list forever to serve the rare moment you cannot find a project; this
// way the cost is paid exactly while you are searching, and the magnifier in the
// header stays pressed the whole time so it is never a mystery why rows are
// missing.
//
// Narrow on purpose: one line, no border box, no button. It sits where the list
// begins, so it reads as the list's own heading rather than as a form.
import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { MAX_QUERY_LENGTH } from "@/lib/search";

export function SearchSlot({
  query,
  matchCount,
  focusTick,
  onQuery,
  onClose,
}: {
  query: string;
  /**
   * How many projects the query leaves. Shown only while something is typed —
   * a zero is the one answer the list itself cannot give, because an empty list
   * looks the same as a broken one.
   */
  matchCount: number;
  /**
   * Counts up every time the shortcut is pressed. The caret goes back into the
   * field then — pressing ⌥F on an open slot has to do something, or the
   * shortcut is dead exactly when you reach for it twice.
   */
  focusTick: number;
  onQuery: (query: string) => void;
  /** Escape, or the ✕ — leaves the search and shows every project again. */
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);

  // Opened to be typed in: anything else would make the magnifier a two-click
  // control for a one-word question.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [focusTick]);

  const typed = query.trim().length > 0;
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-hairline px-3">
      <Icon name="Search" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={field}
        type="text"
        value={query}
        maxLength={MAX_QUERY_LENGTH}
        autoComplete="off"
        spellCheck={false}
        aria-label="Filter projects by name"
        placeholder="Filter projects…"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          // Escape clears first and closes second: while a query is standing,
          // the thing you most likely want back is the full list, not the row.
          if (typed) onQuery("");
          else onClose();
        }}
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
      />
      {typed ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/70">
          {matchCount}
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Close search"
        title="Close search · Esc"
        onClick={onClose}
        className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="X" className="size-3" aria-hidden />
      </button>
    </div>
  );
}
