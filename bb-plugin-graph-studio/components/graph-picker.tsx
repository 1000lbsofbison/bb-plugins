// Choosing a graph out of the library.
//
// This was a `<select>`, and it stopped working at about twenty entries: an
// `<option>` may hold text and nothing else, so everything worth knowing about
// a graph — what it is for, which catalogue pattern it stands for, how big it
// is — had to be crushed into one line, and the ten headings the catalogue is
// ordered by collapsed into two. What a reader needs here is a table with a
// search field over it, which is what this is.
//
// Deliberately a popover rather than the dialog in `responsive-overlay`: the
// question "which graph" is a dropdown-sized question, and a modal that has to
// be dismissed to see the preview underneath answers it more heavily than it
// deserves.
import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { Graph } from "@/lib/graph";
import { groupedLibrary, searchGraphs, templatePattern } from "@/lib/templates";
import { cn } from "@/lib/utils";

export function GraphPicker({
  graphs,
  value,
  onChange,
  disabled,
}: {
  graphs: Graph[];
  value: string;
  onChange: (graphId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = graphs.find((graph) => graph.id === value) ?? null;
  const sections = useMemo(
    () => groupedLibrary(searchGraphs(graphs, term), "section"),
    [graphs, term],
  );
  // The keyboard moves through one flat run of graphs; the headings are not
  // stops. Built from the same sections the eye reads, so "third from the top"
  // means the same thing to both.
  const flat = useMemo(() => sections.flatMap((section) => section.graphs), [sections]);

  // A term that narrows the list can leave the cursor past the end, and a
  // cursor pointing at nothing makes Enter do nothing with no way to see why.
  useEffect(() => {
    setActiveIndex((index) => (index >= flat.length ? 0 : index));
  }, [flat.length]);

  // Opening lands the cursor on what is currently chosen, not at the top: this
  // dropdown is most often opened to look at the neighbours of the current
  // pick, and starting elsewhere loses the place.
  useEffect(() => {
    if (!open) return;
    const at = flat.findIndex((graph) => graph.id === value);
    setActiveIndex(at === -1 ? 0 : at);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector('[data-active="true"]');
    // Guarded rather than called: scrolling is decoration here, and jsdom has
    // no `scrollIntoView` at all — without this the whole picker throws in
    // every test that opens it.
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeIndex]);

  const commit = (graphId: string) => {
    onChange(graphId);
    setOpen(false);
    // Cleared on the way out, so the next opening shows the whole library
    // rather than yesterday's search with everything else apparently gone.
    setTerm("");
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      setTerm("");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + flat.length) % flat.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const graph = flat[activeIndex];
      if (graph) commit(graph.id);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-label="Graph"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md border border-input bg-transparent px-2 text-left text-xs",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              {selected.name}
              <span className="text-muted-foreground">
                {" "}
                · {selected.nodes.length} nodes
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Pick a graph</span>
          )}
        </span>
        <Icon name="ChevronDown" className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <div
          className="absolute left-0 right-0 top-9 z-50 overflow-hidden rounded-md border border-border bg-popover shadow-md"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
            <Icon name="Search" className="size-4 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              // The pattern vocabulary is the point: somebody after "voting"
              // will not guess `ensemble-vote`.
              placeholder="Search — name, purpose or pattern"
              aria-label="Search the library"
              aria-controls="gs-graph-options"
              aria-activedescendant={
                flat[activeIndex] ? `gs-option-${flat[activeIndex].id}` : undefined
              }
              className="h-7 border-0 bg-transparent px-0 focus-visible:ring-0"
            />
          </div>

          <div
            ref={listRef}
            id="gs-graph-options"
            role="listbox"
            aria-label="Library"
            className="max-h-[46vh] overflow-y-auto py-1"
          >
            {flat.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                Nothing matches “{term.trim()}”.
              </p>
            ) : (
              sections.map((section) => (
                <div key={section.key}>
                  <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {section.label}
                  </p>
                  {section.graphs.map((graph) => {
                    const pattern = templatePattern(graph.id);
                    const active = flat[activeIndex]?.id === graph.id;
                    return (
                      <div
                        key={graph.id}
                        id={`gs-option-${graph.id}`}
                        role="option"
                        aria-selected={graph.id === value}
                        data-active={active}
                        tabIndex={-1}
                        onMouseEnter={() =>
                          setActiveIndex(flat.findIndex((entry) => entry.id === graph.id))
                        }
                        onClick={() => commit(graph.id)}
                        className={cn(
                          "cursor-pointer px-2 py-1",
                          active && "bg-accent text-accent-foreground",
                        )}
                      >
                        {/* Three columns, so names line up under names and the
                            sizes read as a column rather than as prose. */}
                        <div className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            {graph.name}
                          </span>
                          <span className="hidden w-[9.5rem] shrink-0 truncate text-[11px] text-muted-foreground sm:block">
                            {pattern ?? ""}
                          </span>
                          <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                            {graph.nodes.length} nodes
                          </span>
                          <Icon
                            name="Check"
                            className={cn(
                              "size-3.5 shrink-0",
                              graph.id === value ? "opacity-100" : "opacity-0",
                            )}
                          />
                        </div>
                        {graph.description ? (
                          <p className="truncate text-[11px] leading-snug text-muted-foreground">
                            {graph.description}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
