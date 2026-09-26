import { describe, expect, it } from "vitest";
import {
  LANE_STATUSES,
  UNKNOWN_COLUMN_ID,
  groupIntoColumns,
  isLaneStatus,
  type BoardTask,
} from "@/lib/columns";

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

describe("isLaneStatus", () => {
  it("accepts every status the CHECK constraint allows", () => {
    for (const status of LANE_STATUSES) expect(isLaneStatus(status)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLaneStatus("blocked")).toBe(false);
    expect(isLaneStatus(undefined)).toBe(false);
  });
});

describe("groupIntoColumns", () => {
  it("always renders the six known columns, empty or not", () => {
    const columns = groupIntoColumns([]);
    expect(columns.map((column) => column.id)).toEqual([...LANE_STATUSES]);
  });

  it("puts a task in the column its status names", () => {
    const columns = groupIntoColumns([
      task({ key: "ABC-1", status: "in_review" }),
    ]);
    const review = columns.find((column) => column.id === "in_review");
    expect(review?.tasks.map((entry) => entry.key)).toEqual(["ABC-1"]);
  });

  it("sorts a column by position", () => {
    const columns = groupIntoColumns([
      task({ key: "ABC-2", position: 9 }),
      task({ key: "ABC-1", position: 2 }),
    ]);
    const todo = columns.find((column) => column.id === "todo");
    expect(todo?.tasks.map((entry) => entry.key)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("breaks a position tie on the key, so two reads agree", () => {
    const columns = groupIntoColumns([
      task({ key: "ABC-2", position: 1 }),
      task({ key: "ABC-1", position: 1 }),
    ]);
    const todo = columns.find((column) => column.id === "todo");
    expect(todo?.tasks.map((entry) => entry.key)).toEqual(["ABC-1", "ABC-2"]);
  });

  // Positive and negative for the unknown-status rule. The negative case is
  // only meaningful next to the positive one: a check that the column is
  // absent stays green when the column never appears at all.
  it("collects an unrecognised status in a visible column", () => {
    const columns = groupIntoColumns([task({ key: "ABC-1", status: "blocked" })]);
    const unknown = columns.find((column) => column.id === UNKNOWN_COLUMN_ID);
    expect(unknown?.tasks.map((entry) => entry.key)).toEqual(["ABC-1"]);
    expect(unknown?.status).toBeNull();
  });

  it("omits the unknown column when every status is known", () => {
    const columns = groupIntoColumns([task({ key: "ABC-1", status: "done" })]);
    expect(columns.find((column) => column.id === UNKNOWN_COLUMN_ID)).toBeUndefined();
  });

  it("collapses done and canceled by default, and nothing else", () => {
    const collapsed = groupIntoColumns([])
      .filter((column) => column.collapsedByDefault)
      .map((column) => column.id);
    expect(collapsed).toEqual(["done", "canceled"]);
  });
});
