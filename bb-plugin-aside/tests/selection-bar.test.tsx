// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  SelectionBar,
  deletionSentence,
} from "@/components/sidenav/selection-bar";

afterEach(cleanup);

function bar(props: Partial<Parameters<typeof SelectionBar>[0]> = {}) {
  return (
    <SelectionBar
      selectedCount={2}
      chosenCount={2}
      alsoDeletedCount={3}
      busy={false}
      onDelete={vi.fn()}
      onClear={vi.fn()}
      {...props}
    />
  );
}

describe("deletion sentence", () => {
  it("names the agents that go down with the threads", () => {
    expect(deletionSentence(2, 3)).toBe("Delete 2 threads and 3 agents below them?");
  });

  it("says nothing about agents when there are none", () => {
    expect(deletionSentence(2, 0)).toBe("Delete 2 threads?");
  });

  it("counts in the singular where one is one", () => {
    expect(deletionSentence(1, 1)).toBe("Delete 1 thread and 1 agent below them?");
  });
});

describe("selection bar", () => {
  // The negative case: a bar visible on an empty selection would be a permanent
  // strip of chrome offering to delete nothing.
  it("stays away entirely while nothing is selected", () => {
    const { container } = render(bar({ selectedCount: 0 }));
    expect(container.firstChild).toBeNull();
  });

  it("appears with the count as soon as something is selected", () => {
    render(bar({ selectedCount: 4 }));
    expect(screen.getByText("4 selected")).toBeTruthy();
  });

  it("does NOT delete on the first press — it asks first", () => {
    const onDelete = vi.fn();
    render(bar({ onDelete }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected threads" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete 2 threads and 3 agents below them\?/)).toBeTruthy();
  });

  it("deletes on the second press", () => {
    const onDelete = vi.fn();
    render(bar({ onDelete }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("takes back the question on Cancel", () => {
    render(bar());
    fireEvent.click(screen.getByRole("button", { name: "Delete selected threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  // A confirmation is an agreement about a number. Changing the selection
  // underneath it has to void that agreement.
  it("drops the confirmation when the selection changes underneath it", () => {
    const { rerender } = render(bar());
    fireEvent.click(screen.getByRole("button", { name: "Delete selected threads" }));
    rerender(bar({ selectedCount: 3, chosenCount: 3 }));
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("refuses a second delete while one is running", () => {
    const onDelete = vi.fn();
    render(bar({ busy: true, onDelete }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected threads" }));
    fireEvent.click(screen.getByRole("button", { name: "Deleting …" }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("clears the selection on Clear", () => {
    const onClear = vi.fn();
    render(bar({ onClear }));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
