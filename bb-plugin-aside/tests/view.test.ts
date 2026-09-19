import { describe, expect, it } from "vitest";
import {
  accordionCollapse,
  allCollapsed,
  DEFAULT_VIEW,
  MAX_IDS,
  parseViewState,
  sectionKey,
  toggleId,
} from "@/lib/view";

describe("reading view state", () => {
  it("accepts valid values", () => {
    const view = parseViewState({
      projectSort: "name",
      threadSort: "state",
      foldQuiet: true,
      collapsedProjects: ["p1"],
    });
    expect(view.projectSort).toBe("name");
    expect(view.threadSort).toBe("state");
    expect(view.foldQuiet).toBe(true);
    expect(view.collapsedProjects).toEqual(["p1"]);
  });

  it("hides empty projects by default", () => {
    expect(DEFAULT_VIEW.emptyProjects).toBe(false);
    expect(parseViewState({ emptyProjects: "ja" }).emptyProjects).toBe(false);
    expect(parseViewState({ emptyProjects: true }).emptyProjects).toBe(true);
  });

  it("falls back to the default on an unknown sort", () => {
    expect(parseViewState({ projectSort: "zufall" }).projectSort).toBe(
      DEFAULT_VIEW.projectSort,
    );
  });

  it("survives broken values from an older version", () => {
    expect(parseViewState("nein")).toEqual(DEFAULT_VIEW);
    expect(parseViewState(null)).toEqual(DEFAULT_VIEW);
    expect(parseViewState({ collapsedProjects: "p1" }).collapsedProjects).toEqual([]);
  });

  it("takes neither non-strings nor duplicates into the id lists", () => {
    const view = parseViewState({ collapsedProjects: ["p1", "p1", 7, "", null] });
    expect(view.collapsedProjects).toEqual(["p1"]);
  });

  it("does not let the id list grow without bound", () => {
    const many = Array.from({ length: MAX_IDS + 50 }, (_, index) => `p${index}`);
    expect(parseViewState({ collapsedProjects: many }).collapsedProjects).toHaveLength(
      MAX_IDS,
    );
  });
});

describe("collapsing", () => {
  it("toggles", () => {
    expect(toggleId([], "p1")).toEqual(["p1"]);
    expect(toggleId(["p1"], "p1")).toEqual([]);
  });

  it("collapses everything but the chosen project in accordion mode", () => {
    expect(accordionCollapse(["p1", "p2", "p3"], "p2")).toEqual(["p1", "p3"]);
  });

  it("does NOT leave the chosen project collapsed", () => {
    expect(accordionCollapse(["p1"], "p1")).toEqual([]);
  });

  it("keeps sections separate per project", () => {
    expect(sectionKey("p1", "s1")).not.toBe(sectionKey("p2", "s1"));
  });
});

describe("fold toggle", () => {
  it("reports all collapsed when every project is", () => {
    expect(allCollapsed(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("reports NOT all collapsed while one project is still open", () => {
    expect(allCollapsed(["a", "b"], ["a"])).toBe(false);
  });

  // Without projects there is nothing collapsed, so the button must offer to
  // collapse — offering to expand nothing would be a lie.
  it("is false without any projects", () => {
    expect(allCollapsed([], [])).toBe(false);
    expect(allCollapsed([], ["stale-id"])).toBe(false);
  });

  // Ids left over from a deleted project must not make the list look folded.
  it("ignores collapsed ids that no longer exist", () => {
    expect(allCollapsed(["a"], ["a", "gone"])).toBe(true);
    expect(allCollapsed(["a", "b"], ["a", "gone"])).toBe(false);
  });
});
