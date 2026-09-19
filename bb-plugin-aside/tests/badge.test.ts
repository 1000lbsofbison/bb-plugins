import { describe, expect, it } from "vitest";
import { countBadgeClass, COUNT_BADGE_SHAPE } from "@/lib/badge";

describe("count badge", () => {
  it("fills the badge while it is expanded", () => {
    expect(countBadgeClass(true)).toContain("bg-sidebar-accent/60");
  });

  it("leaves the badge unfilled while it is collapsed", () => {
    expect(countBadgeClass(false)).not.toContain("bg-sidebar-accent");
  });

  // The regression this function exists for: a collapsed count used to render
  // `border-transparent`, which made it a bare number next to an outlined one.
  it("keeps a visible border in BOTH states", () => {
    for (const open of [true, false]) {
      expect(countBadgeClass(open)).toMatch(/border-border/);
      expect(countBadgeClass(open)).not.toContain("border-transparent");
    }
  });

  it("carries the border in its shared shape, so every count is one badge", () => {
    expect(COUNT_BADGE_SHAPE).toContain("rounded-full");
    expect(COUNT_BADGE_SHAPE).toContain("border");
    expect(COUNT_BADGE_SHAPE).toContain("tabular-nums");
  });
});
