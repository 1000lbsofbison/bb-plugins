import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LENGTH,
  matchesQuery,
  normalizeQuery,
  tagPrefix,
  tagSuggestions,
  queryTerms,
} from "@/lib/search";

describe("normalizeQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeQuery("  graph   studio ")).toBe("graph studio");
  });

  it("removes control characters", () => {
    expect(normalizeQuery("aside\u0000\u001F")).toBe("aside");
  });

  it("caps the length", () => {
    expect(normalizeQuery("x".repeat(500))).toHaveLength(MAX_QUERY_LENGTH);
  });

  it("treats anything that is not a string as no search", () => {
    expect(normalizeQuery(42)).toBe("");
    expect(normalizeQuery(null)).toBe("");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("queryTerms", () => {
  it("splits into folded words", () => {
    expect(queryTerms(" Grün  Studio ")).toEqual(["grun", "studio"]);
  });

  it("is empty for an empty query", () => {
    expect(queryTerms("  ")).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("keeps everything while nothing is typed", () => {
    expect(matchesQuery("Anything", "")).toBe(true);
    expect(matchesQuery("Anything", "   ")).toBe(true);
  });

  it("matches a substring regardless of case", () => {
    expect(matchesQuery("Graph Studio", "STUD")).toBe(true);
  });

  it("ignores accents on both sides", () => {
    expect(matchesQuery("Übersicht", "uber")).toBe(true);
    expect(matchesQuery("Ubersicht", "über")).toBe(true);
  });

  it("asks for every word, in any order", () => {
    expect(matchesQuery("Graph Studio", "studio graph")).toBe(true);
    expect(matchesQuery("Graph Studio", "graph aside")).toBe(false);
  });

  it("does not match a typo", () => {
    expect(matchesQuery("Aside", "asdie")).toBe(false);
  });
});

describe("tag queries", () => {
  it("reads a # query as a tag prefix", () => {
    expect(tagPrefix("#Api")).toBe("api");
    expect(tagPrefix("  #  ")).toBe("");
  });

  it("leaves a name query alone", () => {
    expect(tagPrefix("graph")).toBeNull();
    expect(tagPrefix("")).toBeNull();
    expect(tagPrefix("a#b")).toBeNull();
  });

  it("offers the tags not yet picked, narrowed by the prefix", () => {
    const known = ["api", "app", "web"];
    expect(tagSuggestions(known, ["web"], null)).toEqual(["api", "app"]);
    expect(tagSuggestions(known, [], "ap")).toEqual(["api", "app"]);
    expect(tagSuggestions(known, ["api"], "ap")).toEqual(["app"]);
    expect(tagSuggestions(known, [], "zz")).toEqual([]);
  });
});
