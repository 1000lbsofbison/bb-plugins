// The project-name search.
//
// A second narrowing control next to the tag filter, and deliberately a
// different kind: the tag filter narrows to a set you curated, this one narrows
// to what you are typing right now. So it is not stored on the server with the
// rest of the view — a saved search would greet you on the next device with a
// sidenav that is missing projects for a reason you typed yesterday.
//
// Matching mirrors what bb's own search does on a list of names, so the same
// query finds the same project in both places: case is ignored, accents are
// ignored, and several words are an AND across the name in any order. Nothing
// here is fuzzy — a typo finding a project by accident is worse in a list you
// navigate by muscle memory than a query that simply finds nothing.
//
// Pure data handling: no input is drawn here.

const COMBINING = /[̀-ͯ]/g;
const CONTROL = /[\u0000-\u001F\u007F]/g;
const WHITESPACE = /\s+/g;

/** Long enough for a full project name, short enough to stay one line. */
export const MAX_QUERY_LENGTH = 80;

/** Lower case, no accents — the form both sides of a comparison are in. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING, "")
    .toLocaleLowerCase();
}

/**
 * Tidy what the field holds. An empty result means "no search": the caller then
 * shows everything, rather than matching every project against "".
 */
export function normalizeQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL, "")
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/** The words a query asks for, folded. Empty query = no terms. */
export function queryTerms(query: string): string[] {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return [];
  return fold(normalized).split(" ");
}

/**
 * Does a project name answer the query? Every word has to appear somewhere in
 * the name; their order does not matter, because a list of names is not a
 * sentence and "studio graph" should find "Graph Studio".
 */
export function matchesQuery(name: string, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const folded = fold(name);
  return terms.every((term) => folded.includes(term));
}

/**
 * A query that starts with `#` asks for a tag, not a project name. Returns the
 * folded rest of it — `""` for a bare `#`, which means "show me the tags" — or
 * `null` when the query is a name search.
 */
export function tagPrefix(query: string): string | null {
  const normalized = normalizeQuery(query);
  if (!normalized.startsWith("#")) return null;
  return fold(normalized.slice(1).trim());
}

/**
 * The tags the search slot offers under the field: the ones not yet picked,
 * narrowed to the `#` prefix while one is typed. Alphabetical order comes from
 * the caller.
 */
export function tagSuggestions(
  knownTags: readonly string[],
  active: readonly string[],
  prefix: string | null,
): string[] {
  return knownTags.filter(
    (tag) =>
      !active.includes(tag) && (prefix === null || fold(tag).startsWith(prefix)),
  );
}
