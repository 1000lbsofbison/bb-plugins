// The strip under the header that names everything narrowing the list.
//
// Appears only while something narrows. Each chip removes just its own
// restriction; "Clear all" removes them together. The count on the right says
// how much of the list is left, because an empty list looks exactly like a
// broken one.
import { Icon } from "@/components/ui/icon";
import type { ScopeChip, ScopeKind } from "@/lib/scope";

export function ScopeBar({
  chips,
  shown,
  total,
  onClear,
  onClearAll,
}: {
  chips: readonly ScopeChip[];
  /** Projects the list shows now. */
  shown: number;
  /** Projects it would show without any chip. */
  total: number;
  onClear: (kind: ScopeKind) => void;
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border-hairline px-3 py-1">
      {chips.map((chip) => (
        <button
          key={chip.kind}
          type="button"
          title={`Remove: ${chip.label}`}
          onClick={() => onClear(chip.kind)}
          className="flex max-w-full items-center gap-1 rounded-full border border-border-hairline px-1.5 text-2xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="truncate">{chip.label}</span>
          <Icon name="X" className="size-2.5 shrink-0 opacity-60" aria-hidden />
        </button>
      ))}
      <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground/70">
        {shown} / {total}
      </span>
      {chips.length > 1 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="shrink-0 text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
