import { describe, expect, it, vi } from "vitest";
import { createRowSync, rowStatuses, SPEAKER_ICON } from "./thread-rows";

describe("rowStatuses", () => {
  it("marks threads that chose to speak", () => {
    const statuses = rowStatuses(["a"], null);
    expect(statuses.get("a")).toMatchObject({ icon: SPEAKER_ICON, tone: "default" });
  });

  it("marks nothing when no thread chose to speak and none is speaking", () => {
    expect(rowStatuses([], null).size).toBe(0);
  });

  it("lets the thread being read aloud shimmer", () => {
    expect(rowStatuses(["a"], "a").get("a")?.tone).toBe("running");
    expect(rowStatuses([], "b").get("b")?.tone).toBe("running");
  });
});

describe("createRowSync", () => {
  it("sets new rows and clears rows that dropped out", () => {
    const set = vi.fn();
    const sync = createRowSync(set);
    sync(rowStatuses(["a"], null));
    expect(set).toHaveBeenCalledWith("a", expect.objectContaining({ tone: "default" }));

    set.mockClear();
    sync(rowStatuses([], null));
    expect(set).toHaveBeenCalledWith("a", null);
  });

  it("does not re-send an unchanged row", () => {
    const set = vi.fn();
    const sync = createRowSync(set);
    sync(rowStatuses(["a"], null));
    set.mockClear();
    sync(rowStatuses(["a"], null));
    expect(set).not.toHaveBeenCalled();
  });

  it("re-sends a row whose tone changed", () => {
    const set = vi.fn();
    const sync = createRowSync(set);
    sync(rowStatuses(["a"], null));
    set.mockClear();
    sync(rowStatuses(["a"], "a"));
    expect(set).toHaveBeenCalledWith("a", expect.objectContaining({ tone: "running" }));
  });
});
