// The View menu — successor to the filter button.
//
// It removes nothing. It sorts, condenses, and at most reveals something extra
// (archived threads). That is exactly why it is called View.
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import type { ProjectSort, ThreadSort, ViewState } from "@/lib/view";

// Folding is NOT in here: it is one gesture with two directions, which a menu
// turns into two entries you have to read before picking. It sits next to this
// trigger as its own button.
export function ViewMenu({
  view,
  onPatch,
}: {
  view: ViewState;
  onPatch: (patch: Partial<ViewState>) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="View: sort and condense"
          title="View: sort and condense"
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="SlidersHorizontal" className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">
          Sort projects
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.projectSort}
          onValueChange={(value) => onPatch({ projectSort: value as ProjectSort })}
        >
          <DropdownMenuRadioItem value="manual">Manual — as dragged</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="activity">Where things happen</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name">Name A–Z</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">
          Sort threads
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.threadSort}
          onValueChange={(value) => onPatch({ threadSort: value as ThreadSort })}
        >
          <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="state">By state</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">
          View
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={view.foldQuiet}
          onCheckedChange={(checked) => onPatch({ foldQuiet: checked === true, openQuiet: [] })}
        >
          Condense quiet ones
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={view.accordion}
          onCheckedChange={(checked) => onPatch({ accordion: checked === true })}
        >
          One project open at a time
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={view.archived}
          onCheckedChange={(checked) => onPatch({ archived: checked === true })}
        >
          Show archived
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={view.emptyProjects}
          onCheckedChange={(checked) => onPatch({ emptyProjects: checked === true })}
        >
          Show empty projects
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={view.compact}
          onCheckedChange={(checked) => onPatch({ compact: checked === true })}
        >
          Single line
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
