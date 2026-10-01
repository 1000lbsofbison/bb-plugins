// "Open all" (§4.6): the split for each member thread, in the order they
// open. Up to three members sit side by side; from four on they form a
// grid — the first row opens to the right, the rest opens downward under it,
// which BB applies to the pane that opened last (live check: see README).
import type { OpenSplit } from "./thread-port";

export function openLayout(count: number): OpenSplit[] {
  if (count <= 0) return [];
  if (count < 4) return ["replace", ...Array.from({ length: count - 1 }, () => "right" as const)];
  const columns = Math.ceil(count / 2);
  return ["replace", ...Array.from({ length: columns - 1 }, () => "right" as const), ...Array.from({ length: count - columns }, () => "down" as const)];
}
