// The tag filter — the one control in this sidenav that removes rows.
//
// It sits apart from the View menu for exactly that reason. View sorts,
// condenses and at most reveals something extra; this narrows. Giving it its
// own funnel keeps the distinction visible instead of hiding a filter among
// the checkboxes that never take anything away.
//
// What makes it defensible where a state filter was not: you choose the tags
// yourself, so the result is a list you meant, not one a machine derived from a
// state that changes on its own. And it is announced — the funnel fills and
// carries the count while it is on, because a filter you have forgotten about
// is a sidenav that appears to have lost projects.
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { RowCount } from "@/components/sidenav/row-slots";
import { cn } from "@/lib/utils";

export function TagFilter({
  tags,
  counts,
  active,
  onToggle,
  onClear,
}: {
  /** Every tag in use, alphabetical. */
  tags: readonly string[];
  /**
   * How many projects carry each tag. The same count badge every other row in
   * this sidenav uses, filled while the tag is picked — so a pick reads here
   * exactly as an expanded project reads in the list.
   */
  counts: Readonly<Record<string, number>>;
  /** The tags currently filtered on. */
  active: readonly string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const on = active.length > 0;
  const label = on
    ? `Tags: ${active.join(", ")} — click to change`
    : "Filter by tag";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={on}
          title={label}
          className={cn(
            "flex h-6 items-center gap-1 rounded-md px-1 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            on ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon name="Filter" className="size-3.5" aria-hidden />
          {on ? <span className="text-2xs tabular-nums">{active.length}</span> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">
          Filter by tag
        </DropdownMenuLabel>
        {tags.length === 0 ? (
          // Not an empty menu: a control that opens onto nothing reads as
          // broken. It says where tags come from instead.
          <div className="px-2 py-1.5 text-2xs text-muted-foreground">
            No tags yet — right-click a project to add one.
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {tags.map((tag) => (
              <DropdownMenuCheckboxItem
                key={tag}
                checked={active.includes(tag)}
                onSelect={(event) => {
                  // Several picks in one visit: the menu stays open.
                  event.preventDefault();
                  onToggle(tag);
                }}
              >
                <span className="truncate">{tag}</span>
                {/* Hangs off the end of the name, the way a count hangs off a
                    project's title — not at the right edge, where it would
                    line up against nothing. */}
                <RowCount
                  count={counts[tag] ?? 0}
                  open={active.includes(tag)}
                  className="ml-1.5"
                />
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!on} onSelect={onClear}>
          Show all projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
