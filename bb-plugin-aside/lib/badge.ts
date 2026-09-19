// The count badge, shared by the project row, the section row and a card's
// agent count.
//
// One function rather than three copies of the same class list: the three rows
// drifted apart once already — the project count was drawn as an outlined badge
// while a card's agent count was a bare number, so the same piece of
// information looked like two different things in one column.
//
// The outline is therefore constant and only the fill carries the state: filled
// means expanded, unfilled means collapsed. A badge that loses its border while
// collapsed stops reading as a badge at all.
export function countBadgeClass(open: boolean): string {
  return open
    ? "border-border bg-sidebar-accent/60 text-muted-foreground"
    : "border-border/60 text-muted-foreground/70";
}

/** The geometry every count shares — size, roundness, digit alignment. */
export const COUNT_BADGE_SHAPE =
  "grid h-4 min-w-5 place-items-center rounded-full border px-1.5 text-2xs tabular-nums";
