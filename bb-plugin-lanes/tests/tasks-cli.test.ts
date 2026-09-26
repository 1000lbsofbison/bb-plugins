import { describe, expect, it } from "vitest";
import { buildUpdateStatusArgs, isTaskKey } from "@/lib/tasks-cli";

describe("isTaskKey", () => {
  it("accepts a key in the shape bb tasks update takes", () => {
    expect(isTaskKey("ABC-12")).toBe(true);
    expect(isTaskKey("s1-1")).toBe(true);
  });

  it("rejects anything that is not one", () => {
    // The value arrives from the frontend and becomes an argv entry, so the
    // negative cases are the point of the check, not decoration.
    expect(isTaskKey("ABC-0")).toBe(false);
    expect(isTaskKey("ABC")).toBe(false);
    expect(isTaskKey("--status")).toBe(false);
    expect(isTaskKey("ABC-1 --title x")).toBe(false);
    expect(isTaskKey("")).toBe(false);
  });
});

describe("buildUpdateStatusArgs", () => {
  it("builds exactly the documented invocation", () => {
    expect(buildUpdateStatusArgs("ABC-12", "in_progress")).toEqual([
      "tasks",
      "update",
      "ABC-12",
      "--status",
      "in_progress",
      "--json",
    ]);
  });

  it("refuses to build a command around a key it does not recognise", () => {
    expect(() => buildUpdateStatusArgs("; rm -rf /", "done")).toThrow();
  });

  it("carries no --position, because the CLI has no such flag", () => {
    // Measured against `bb tasks update --help` on bb 0.43.3: status, priority,
    // title, description, due, parent, labels and machine — nothing that sets
    // manual order. Within-column drag is therefore not offered at all rather
    // than offered and silently forgotten on refresh.
    expect(buildUpdateStatusArgs("ABC-1", "todo")).not.toContain("--position");
  });
});
