// What is narrowing the list right now, as a row of chips.
//
// Search, tags and "Archived threads" used to live in three places with three
// different ways of showing that they were on. They are collected here so the
// sidenav can show every one of them in one strip, each with its own ✕ — a
// filter you have forgotten about is a sidenav that appears to have lost rows.
//
// Pure data: no chip is drawn here.
import { normalizeQuery, tagPrefix } from "./search";

export type ScopeKind = "search" | "tags" | "archived";

export interface ScopeChip {
  kind: ScopeKind;
  label: string;
}

export function activeScopes({
  query,
  tagFilter,
  archived,
}: {
  query: string;
  tagFilter: readonly string[];
  archived: boolean;
}): ScopeChip[] {
  const chips: ScopeChip[] = [];
  const normalized = normalizeQuery(query);
  // A `#` query is a tag being picked, not a name search: it narrows nothing
  // until a tag is chosen, and then the tag chip says so.
  if (normalized.length > 0 && tagPrefix(normalized) === null) {
    chips.push({ kind: "search", label: `“${normalized}”` });
  }
  if (tagFilter.length > 0) {
    chips.push({ kind: "tags", label: tagFilter.map((tag) => `#${tag}`).join(" · ") });
  }
  // Archived adds rows rather than removing them, but it changes what the list
  // is just the same, and it is the switch people forget they turned on.
  if (archived) chips.push({ kind: "archived", label: "Archived" });
  return chips;
}

