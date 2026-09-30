// The three menus in the header, one question each.
//
// Sort: in which order? Display: what, and how dense? More: things to do rather
// than settings to keep. They used to share one "View" menu, which mixed an
// order, two amounts, a density and a behaviour under one icon — and hid the
// one switch that changes which rows exist ("Archived") among the ones that
// only rearrange them.
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VIEW,
  type ProjectSort,
  type ThreadSort,
  type ViewState,
} from "@/lib/view";

const LABEL = "text-2xs uppercase tracking-wide text-muted-foreground";

function Trigger({
  icon,
  label,
  pressed,
  badge,
}: {
  icon: string;
  label: string;
  pressed?: boolean;
  /** Short text beside the icon — the current choice, when it is not the default. */
  badge?: string | null;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        aria-label={badge ? `${label}: ${badge}` : label}
        title={badge ? `${label}: ${badge}` : label}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md px-1 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          pressed || badge ? "text-foreground" : "text-muted-foreground",
          pressed && "bg-sidebar-accent",
        )}
      >
        <Icon name={icon} className="size-3.5" aria-hidden />
        {badge ? <span className="text-2xs tabular-nums">{badge}</span> : null}
      </button>
    </DropdownMenuTrigger>
  );
}

const PROJECT_SORT_BADGE: Record<ProjectSort, string | null> = {
  manual: null,
  activity: "Activity",
  name: "A–Z",
};

/** The trigger names the current order only when it differs from the default. */
export function sortBadge(view: Pick<ViewState, "projectSort" | "threadSort">): string | null {
  const parts = [
    PROJECT_SORT_BADGE[view.projectSort],
    view.threadSort === DEFAULT_VIEW.threadSort ? null : "State",
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function SortMenu({
  view,
  onPatch,
}: {
  view: ViewState;
  onPatch: (patch: Partial<ViewState>) => void;
}) {
  return (
    <DropdownMenu>
      <Trigger icon="ArrowUpDown" label="Sort" badge={sortBadge(view)} />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className={LABEL}>Projects</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.projectSort}
          onValueChange={(value) => onPatch({ projectSort: value as ProjectSort })}
        >
          <DropdownMenuRadioItem value="manual">
            Manual
            <DropdownMenuShortcut>as dragged</DropdownMenuShortcut>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="activity">Recent activity</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name">Name A–Z</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={LABEL}>Threads</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.threadSort}
          onValueChange={(value) => onPatch({ threadSort: value as ThreadSort })}
        >
          <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="state">
            By state
            <DropdownMenuShortcut>needs you first</DropdownMenuShortcut>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Pinned threads always stay on top</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DisplayMenu({
  view,
  onPatch,
}: {
  view: ViewState;
  onPatch: (patch: Partial<ViewState>) => void;
}) {
  return (
    <DropdownMenu>
      <Trigger icon="Rows2" label="Display" />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className={LABEL}>Density</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.compact ? "single" : "comfortable"}
          onValueChange={(value) => onPatch({ compact: value === "single" })}
        >
          <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="single">Single line</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={LABEL}>Show</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={view.pinnedGroup}
          onCheckedChange={(checked) => onPatch({ pinnedGroup: checked === true })}
        >
          Pinned group
          <DropdownMenuShortcut>across projects</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={view.foldQuiet}
          onCheckedChange={(checked) => onPatch({ foldQuiet: checked === true, openQuiet: [] })}
        >
          Condense quiet threads
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={view.archived}
          onCheckedChange={(checked) => onPatch({ archived: checked === true })}
        >
          Archived threads
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={view.emptyProjects}
          onCheckedChange={(checked) => onPatch({ emptyProjects: checked === true })}
        >
          Empty projects
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={LABEL}>Behaviour</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={view.focusFollows}
          onCheckedChange={(checked) => onPatch({ focusFollows: checked === true })}
        >
          Focus follows active thread
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MoreMenu({
  selecting,
  filterCount,
  viewIsDefault,
  onCollapseAll,
  onExpandAll,
  onToggleSelecting,
  onClearFilters,
  onResetView,
}: {
  selecting: boolean;
  /** How many narrowing chips are standing — what "Clear filters" would remove. */
  filterCount: number;
  viewIsDefault: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onToggleSelecting: () => void;
  onClearFilters: () => void;
  onResetView: () => void;
}) {
  return (
    <DropdownMenu>
      {/* Pressed while selecting: the mode must say it is on from the one
          control that turns it off again. */}
      <Trigger icon="MoreHorizontal" label="More" pressed={selecting} />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onCollapseAll}>
          <Icon name="ChevronsUp" className="size-3.5" aria-hidden />
          Collapse all
          <DropdownMenuShortcut>⌥C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onExpandAll}>
          <Icon name="ChevronsDown" className="size-3.5" aria-hidden />
          Expand all
          <DropdownMenuShortcut>⌥⇧C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onToggleSelecting}>
          <Icon name="ListTodo" className="size-3.5" aria-hidden />
          {selecting ? "Leave selection mode" : "Select threads…"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={filterCount === 0} onSelect={onClearFilters}>
          <Icon name="X" className="size-3.5" aria-hidden />
          Clear filters
          {filterCount > 0 ? (
            <DropdownMenuShortcut>{filterCount} active</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={viewIsDefault} onSelect={onResetView}>
          <Icon name="RotateCcw" className="size-3.5" aria-hidden />
          Reset view to defaults
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
