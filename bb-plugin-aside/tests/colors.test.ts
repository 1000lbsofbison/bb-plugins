import { describe, expect, it } from "vitest";
import {
  AUTO_PALETTE,
  automaticColor,
  badgeColor,
  badgeForeground,
  badgeLetter,
  contrastRatio,
  normalizeColor,
  validProjectId,
} from "@/lib/colors";

describe("project colour", () => {
  it("accepts a valid hex value", () => {
    expect(normalizeColor("#52a8ff")).toBe("#52A8FF");
  });

  it("rejects anything that is not a six-digit hex value", () => {
    expect(normalizeColor("#52a")).toBeNull();
    expect(normalizeColor("rot")).toBeNull();
    expect(normalizeColor("javascript:alert(1)")).toBeNull();
    expect(normalizeColor(42)).toBeNull();
    expect(normalizeColor(null)).toBeNull();
  });

  it("falls back to the automatic colour on an invalid override", () => {
    expect(badgeColor("p1", "kaputt")).toBe(automaticColor("p1"));
  });

  it("gives the same project id the same colour every time", () => {
    expect(automaticColor("mastra-ai-proxy")).toBe(automaticColor("mastra-ai-proxy"));
  });

  it("NEVER hands out black or white automatically", () => {
    for (const id of ["a", "b", "c", "projekt-1", "x".repeat(40)]) {
      expect(["#FFFFFF", "#000000"]).not.toContain(automaticColor(id));
    }
    expect(AUTO_PALETTE).not.toContain("#000000");
  });

  it("picks the more readable type colour", () => {
    expect(badgeForeground("#000000")).toBe("#FFFFFF");
    expect(badgeForeground("#FFFFFF")).toBe("#000000");
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
  });

  it("rejects project ids containing control characters", () => {
    expect(validProjectId("p1")).toBe(true);
    expect(validProjectId("")).toBe(false);
    expect(validProjectId("p\u00011")).toBe(false);
    expect(validProjectId("x".repeat(201))).toBe(false);
  });
});
