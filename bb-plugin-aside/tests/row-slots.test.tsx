// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { RowCount, RowTail } from "@/components/sidenav/row-slots";

afterEach(cleanup);

const NOW = 1_700_000_000_000;
const TWO_HOURS = 2 * 60 * 60 * 1000;

describe("row count", () => {
  it("renders the count as a button where it is the toggle", () => {
    const onClick = vi.fn();
    render(
      <RowCount
        count={4}
        open={false}
        onToggle={{ onClick, label: "Show 4 agents", title: "4 agents — show" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 4 agents" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders the count WITHOUT a button where the whole row toggles", () => {
    render(<RowCount count={4} open />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("fills the badge while expanded and leaves it unfilled while collapsed", () => {
    const { container: open } = render(<RowCount count={2} open />);
    expect(open.firstElementChild?.className).toContain("bg-sidebar-accent/60");
    cleanup();
    const { container: shut } = render(<RowCount count={2} open={false} />);
    expect(shut.firstElementChild?.className).not.toContain("bg-sidebar-accent/60");
  });
});

describe("row tail", () => {
  it("shows the age it was given", () => {
    const { container } = render(
      <RowTail age={NOW - TWO_HOURS} now={NOW} state={null} />,
    );
    expect(container.textContent).toContain("2h");
  });

  // The negative case that matters: an empty project has nothing to date. The
  // slot has to survive anyway, or the mark leaves its column.
  it("keeps the age slot but writes nothing when there is no age", () => {
    const { container } = render(<RowTail age={null} now={NOW} state="needs-you" />);
    const slot = container.querySelector("div")?.firstElementChild;
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Waiting for you" })).toBeTruthy();
  });

  it("draws the mark on a quiet row as well", () => {
    render(<RowTail age={NOW} now={NOW} state="quiet" />);
    expect(screen.getByRole("img", { name: "Quiet" })).toBeTruthy();
  });

  it("draws the mark on a row that is NOT quiet", () => {
    render(<RowTail age={NOW} now={NOW} state="needs-you" />);
    expect(screen.getByRole("img", { name: "Waiting for you" })).toBeTruthy();
  });

  // Two slots, always the same two. A tail that sometimes has one and sometimes
  // two is the thing that made quiet rows look like another kind of row.
  it("carries exactly two slots, whatever the state", () => {
    for (const state of ["quiet", "needs-you", "failed"] as const) {
      const { container, unmount } = render(
        <RowTail age={NOW} now={NOW} state={state} />,
      );
      expect(container.querySelector("div")?.children).toHaveLength(2);
      unmount();
    }
  });

  // The tail carries the row's condition only. A count here would put the same
  // information on both edges.
  it("carries NO count", () => {
    const { container } = render(
      <RowTail age={NOW - TWO_HOURS} now={NOW} state="needs-you" />,
    );
    // The mark's SVG carries a <title>, so compare the slots rather than the
    // whole text: age, mark, and nothing numeric besides the age itself.
    const slots = [...(container.querySelector("div")?.children ?? [])];
    expect(slots).toHaveLength(2);
    expect(slots[0].textContent).toBe("2h");
    expect(slots[1].querySelector("svg")).not.toBeNull();
  });
});
