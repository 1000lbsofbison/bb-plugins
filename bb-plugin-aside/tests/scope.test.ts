import { describe, expect, it } from "vitest";
import { activeScopes } from "@/lib/scope";

describe("scope chips", () => {
  it("names every restriction that is standing", () => {
    expect(activeScopes({ query: " studio ", tagFilter: ["api", "web"], archived: true })).toEqual([
      { kind: "search", label: "“studio”" },
      { kind: "tags", label: "#api · #web" },
      { kind: "archived", label: "Archived" },
    ]);
  });

  it("is empty while nothing narrows", () => {
    expect(activeScopes({ query: "   ", tagFilter: [], archived: false })).toEqual([]);
  });

  it("does not count a # query as a name search", () => {
    expect(activeScopes({ query: "#ap", tagFilter: [], archived: false })).toEqual([]);
  });
});
