import { describe, expect, it } from "vitest";
import { relativeAge } from "@/lib/time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

describe("relative age", () => {
  it("says 'now' below a minute", () => {
    expect(relativeAge(NOW, NOW)).toBe("now");
    expect(relativeAge(NOW - 59_000, NOW)).toBe("now");
  });

  it("counts minutes below an hour", () => {
    expect(relativeAge(NOW - 5 * MINUTE, NOW)).toBe("5m");
    expect(relativeAge(NOW - 59 * MINUTE, NOW)).toBe("59m");
  });

  it("counts hours below a day", () => {
    expect(relativeAge(NOW - 2 * HOUR, NOW)).toBe("2h");
    expect(relativeAge(NOW - 23 * HOUR, NOW)).toBe("23h");
  });

  it("counts days beyond that", () => {
    expect(relativeAge(NOW - 3 * DAY, NOW)).toBe("3d");
    expect(relativeAge(NOW - 400 * DAY, NOW)).toBe("400d");
  });

  // The unit letters are English. The module used to print the German "T" for
  // days and "Std" for hours, and "jetzt" instead of "now".
  it("uses NO German unit letters and NO German words", () => {
    const samples = [0, 30_000, 5 * MINUTE, 2 * HOUR, 3 * DAY, 400 * DAY].map(
      (age) => relativeAge(NOW - age, NOW),
    );
    for (const sample of samples) {
      expect(sample).not.toMatch(/T$/);
      expect(sample).not.toMatch(/Std/);
      expect(sample).not.toBe("jetzt");
    }
  });

  it("never reports a negative age for a timestamp in the future", () => {
    expect(relativeAge(NOW + 10 * DAY, NOW)).toBe("now");
  });
});
