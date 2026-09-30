import { describe, expect, it } from "vitest";
import { sortBadge } from "@/components/sidenav/header-menus";

describe("sort badge", () => {
  it("stays empty for the default order", () => {
    expect(sortBadge({ projectSort: "manual", threadSort: "newest" })).toBeNull();
  });

  it("names every order away from the default", () => {
    expect(sortBadge({ projectSort: "name", threadSort: "newest" })).toBe("A–Z");
    expect(sortBadge({ projectSort: "manual", threadSort: "state" })).toBe("State");
    expect(sortBadge({ projectSort: "activity", threadSort: "state" })).toBe("Activity · State");
  });
});
