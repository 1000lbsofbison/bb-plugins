// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  NEEDS_YOU_RADIUS,
  QUIET_RADIUS,
  StateMark,
  UNREAD_RADIUS,
  stateLabel,
} from "@/components/sidenav/marks";
import { THREAD_STATE_RANK, type ThreadState } from "@/lib/tree";

afterEach(cleanup);

const STATES = Object.keys(THREAD_STATE_RANK) as ThreadState[];

function radiusOf(state: ThreadState): number | null {
  const { container } = render(<StateMark state={state} />);
  const circle = container.querySelector("circle");
  return circle === null ? null : Number(circle.getAttribute("r"));
}

describe("state marks", () => {
  // Every state draws something. A row with no mark reads as "unknown", not as
  // "nothing going on" — that ambiguity is why quiet group rows used to look
  // like a different kind of row.
  it("draws a mark for EVERY state, quiet included", () => {
    for (const state of STATES) {
      const { unmount } = render(<StateMark state={state} />);
      expect(screen.getByRole("img", { name: stateLabel(state) })).toBeTruthy();
      unmount();
    }
  });

  // The positive case for the ranking: a blocked row outgrows a merely unread
  // one. Asserting the order rather than the literals, so tuning the numbers
  // stays possible without the test going quiet about what it protects.
  it("draws needs-you larger than every other mark", () => {
    expect(radiusOf("needs-you")).toBe(NEEDS_YOU_RADIUS);
    cleanup();
    expect(radiusOf("unread")).toBe(UNREAD_RADIUS);
    expect(NEEDS_YOU_RADIUS).toBeGreaterThan(UNREAD_RADIUS);
  });

  // The negative case: growing it must not push the dot into the viewport edge,
  // where it stops reading as a dot and starts reading as a clipped shape.
  it("keeps needs-you clear of the 14x14 viewport edge", () => {
    expect(NEEDS_YOU_RADIUS).toBeLessThanOrEqual(6);
  });

  // The negative case: quiet must stay clearly below them, or "nothing pending"
  // competes for the eye with "answer me".
  it("keeps quiet well below the attention marks", () => {
    expect(QUIET_RADIUS).toBeLessThan(UNREAD_RADIUS / 2);
    expect(radiusOf("quiet")).toBe(QUIET_RADIUS);
  });

  it("pulses only the mark that waits for you", () => {
    const { container: waiting } = render(<StateMark state="needs-you" />);
    expect(waiting.querySelector("circle")?.getAttribute("class")).toContain("animate-pulse");
    cleanup();
    const { container: unread } = render(<StateMark state="unread" />);
    expect(unread.querySelector("circle")?.getAttribute("class")).not.toContain("animate-pulse");
  });

  // Colour carries meaning for exactly two states. The rest must stay greyscale,
  // or the palette stops being a signal.
  it("uses colour ONLY for waiting and failed", () => {
    const coloured = (state: ThreadState) => {
      const { container } = render(<StateMark state={state} />);
      const painted = container.querySelector("circle, path")?.getAttribute("class") ?? "";
      cleanup();
      return /--primary|destructive/.test(painted);
    };
    expect(coloured("needs-you")).toBe(true);
    expect(coloured("failed")).toBe(true);
    expect(coloured("working")).toBe(false);
    expect(coloured("unread")).toBe(false);
    expect(coloured("quiet")).toBe(false);
  });

  // The negative case for the palette: the two coloured states must not share a
  // hue. Told apart by colour is the whole point — dot versus cross is a detail
  // you only see once you are already looking at the row.
  it("does NOT paint waiting in the failure colour", () => {
    const { container } = render(<StateMark state="needs-you" />);
    const painted = container.querySelector("circle")?.getAttribute("class") ?? "";
    expect(painted).toContain("--primary");
    expect(painted).not.toContain("destructive");
  });
});
