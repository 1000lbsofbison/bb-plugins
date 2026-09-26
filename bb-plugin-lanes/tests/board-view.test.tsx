// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BoardView } from "@/components/board-view";
import { groupIntoColumns, type BoardTask } from "@/lib/columns";

afterEach(cleanup);

function task(overrides: Partial<BoardTask> & { key: string }): BoardTask {
  return {
    id: overrides.key,
    title: overrides.key,
    status: "todo",
    priority: "none",
    position: 1,
    labels: [],
    liveThread: false,
    ...overrides,
  };
}

function renderBoard(tasks: BoardTask[], onMove = vi.fn()) {
  render(
    <BoardView
      columns={groupIntoColumns(tasks)}
      unavailable={null}
      onMove={onMove}
    />,
  );
  return onMove;
}

describe("the live-thread indicator", () => {
  // Positive first. Without it, the negative test below stays green even if the
  // indicator renders nowhere at all — the trap AGENTS.md names.
  it("appears on a card with a live thread", () => {
    renderBoard([task({ key: "ABC-1", liveThread: true })]);
    expect(screen.getByTestId("live-ABC-1")).toBeDefined();
  });

  it("does not appear on a card without one", () => {
    renderBoard([
      task({ key: "ABC-1", liveThread: true }),
      task({ key: "ABC-2", liveThread: false, position: 2 }),
    ]);
    expect(screen.getByTestId("live-ABC-1")).toBeDefined();
    expect(screen.queryByTestId("live-ABC-2")).toBeNull();
  });
});

describe("the unsupported-schema refusal", () => {
  it("renders the message and no board when the schema moved on", () => {
    render(
      <BoardView
        columns={groupIntoColumns([task({ key: "ABC-1" })])}
        unavailable={{ kind: "unsupported-schema", found: 9, supported: 6 }}
        onMove={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("schema version 9");
    expect(screen.queryByTestId("board")).toBeNull();
  });

  it("renders the board and no message on the supported schema", () => {
    renderBoard([task({ key: "ABC-1" })]);
    expect(screen.getByTestId("board")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a message rather than an empty board when there is no database", () => {
    render(
      <BoardView columns={[]} unavailable={{ kind: "missing" }} onMove={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("No Tasks database");
  });
});

describe("a status the plugin does not know", () => {
  it("lands in a visible column instead of vanishing", () => {
    renderBoard([task({ key: "ABC-1", status: "blocked" })]);
    expect(screen.getByTestId("card-ABC-1")).toBeDefined();
    expect(screen.getByTestId("column-unknown")).toBeDefined();
  });

  it("leaves that column out when every status is known", () => {
    renderBoard([task({ key: "ABC-1", status: "todo" })]);
    expect(screen.getByTestId("card-ABC-1")).toBeDefined();
    expect(screen.queryByTestId("column-unknown")).toBeNull();
  });
});

describe("moving a card by keyboard", () => {
  it("moves to the next status on Alt+ArrowRight", () => {
    const onMove = renderBoard([task({ key: "ABC-1", status: "todo" })]);
    fireEvent.keyDown(screen.getByTestId("card-ABC-1"), {
      key: "ArrowRight",
      altKey: true,
    });
    expect(onMove).toHaveBeenCalledWith("ABC-1", "in_progress");
  });

  it("does nothing at the left edge of the board", () => {
    const onMove = renderBoard([task({ key: "ABC-1", status: "backlog" })]);
    fireEvent.keyDown(screen.getByTestId("card-ABC-1"), {
      key: "ArrowLeft",
      altKey: true,
    });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("does nothing without the modifier, so plain arrows still scroll", () => {
    const onMove = renderBoard([task({ key: "ABC-1", status: "todo" })]);
    fireEvent.keyDown(screen.getByTestId("card-ABC-1"), { key: "ArrowRight" });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("moves a card out of the unknown column into a real status", () => {
    const onMove = renderBoard([task({ key: "ABC-1", status: "blocked" })]);
    fireEvent.keyDown(screen.getByTestId("card-ABC-1"), {
      key: "ArrowLeft",
      altKey: true,
    });
    expect(onMove).toHaveBeenCalledWith("ABC-1", "backlog");
  });
});

describe("dropping a card on a column", () => {
  it("reports the target status", () => {
    const onMove = renderBoard([task({ key: "ABC-1", status: "todo" })]);
    fireEvent.dragStart(screen.getByTestId("card-ABC-1"));
    fireEvent.drop(screen.getByTestId("column-done"));
    expect(onMove).toHaveBeenCalledWith("ABC-1", "done");
  });

  it("refuses a drop on the unknown column, which has no status to write", () => {
    const onMove = renderBoard([
      task({ key: "ABC-1", status: "todo" }),
      task({ key: "ABC-2", status: "blocked" }),
    ]);
    fireEvent.dragStart(screen.getByTestId("card-ABC-1"));
    fireEvent.drop(screen.getByTestId("column-unknown"));
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("the finished columns", () => {
  it("start collapsed, hiding their cards", () => {
    renderBoard([task({ key: "ABC-1", status: "done" })]);
    expect(screen.queryByTestId("card-ABC-1")).toBeNull();
  });

  it("show their cards once expanded", () => {
    renderBoard([task({ key: "ABC-1", status: "done" })]);
    fireEvent.click(
      screen.getByRole("button", { name: /Done/ }),
    );
    expect(screen.getByTestId("card-ABC-1")).toBeDefined();
  });

  it("leaves the working columns expanded", () => {
    renderBoard([task({ key: "ABC-1", status: "todo" })]);
    expect(screen.getByTestId("card-ABC-1")).toBeDefined();
  });
});
