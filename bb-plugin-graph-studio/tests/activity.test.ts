// What a worker is doing, read off a BB thread event.
//
// The shapes below are measured, not assumed: they are copied from
// `bb thread log --self --json` on a real Claude Code thread. That measurement
// corrected two things a reading of the SDK types had got wrong — the specific
// part of a line lives in `presentation.title`, not in `detail`, and the two
// most frequent item types (`agentMessage`, `commandExecution`) arrive with no
// presentation at all. Both mistakes would have compiled, passed a typed test,
// and shown "Running command" under every node for ten minutes.
import { describe, expect, it } from "vitest";
import { activityByNode, describeActivity, durationByNode, elapsedLabel } from "../lib/activity";

const started = (item: Record<string, unknown>) => ({
  item,
  threadId: "thr_1",
  providerThreadId: "p_1",
});

describe("describeActivity", () => {
  // Verbatim from a real thread's `item/started`.
  it("prefers BB's own wording, and keeps the part that identifies the call", () => {
    expect(
      describeActivity(
        started({
          type: "commandExecution",
          status: "pending",
          presentation: {
            label: { pending: "Running command", completed: "Ran command" },
            icon: { glyph: "Terminal" },
            title: "npx vitest run",
          },
        }),
      ),
    ).toBe("Running command: npx vitest run");
  });

  it("takes the completed wording once the item is done", () => {
    expect(
      describeActivity(
        started({
          type: "commandExecution",
          status: "completed",
          presentation: {
            label: { pending: "Running command", completed: "Ran command" },
            icon: { glyph: "Terminal" },
            title: "npx vitest run",
          },
        }),
      ),
    ).toBe("Ran command: npx vitest run");
  });

  // `reasoning` and `agentMessage` report no status at all — measured. Without
  // this the canvas would say "Ran" about something that just began.
  it("reads a missing status as pending, not as finished", () => {
    expect(
      describeActivity(
        started({
          type: "fileChange",
          presentation: {
            label: { pending: "Writing file", completed: "Wrote file" },
            icon: { glyph: "EditFile" },
            title: "activity.ts",
          },
        }),
      ),
    ).toBe("Writing file: activity.ts");
  });

  // BB keeps these out of its own timeline; the canvas must not be louder
  // about a worker than the worker's thread is.
  it("says nothing about an item BB itself suppresses", () => {
    expect(
      describeActivity(
        started({
          type: "toolCall",
          tool: "AskUserQuestion",
          status: "pending",
          presentation: {
            label: { pending: "Asking a question", completed: "Asked a question" },
            icon: { glyph: "MessageQuestion" },
            suppress: true,
          },
        }),
      ),
    ).toBeNull();
  });

  // The two most common items of all, and neither carries a presentation.
  it("describes the items that arrive bare", () => {
    expect(
      describeActivity(started({ type: "agentMessage", text: "Let me look." })),
    ).toBe("Writing: Let me look.");
    expect(describeActivity(started({ type: "agentMessage", text: "" }))).toBe(
      "Writing",
    );
    expect(
      describeActivity(started({ type: "commandExecution", cmd: "git status" })),
    ).toBe("git status");
    expect(
      describeActivity(started({ type: "fileChange", path: "lib/activity.ts" })),
    ).toBe("Editing lib/activity.ts");
  });

  it("falls back to the tool name when there is no presentation", () => {
    expect(
      describeActivity(started({ type: "toolCall", tool: "Edit", status: "pending" })),
    ).toBe("Edit");
  });

  it("names an MCP server alongside its tool", () => {
    expect(
      describeActivity(
        started({ type: "toolCall", tool: "search", server: "sentry", status: "pending" }),
      ),
    ).toBe("sentry · search");
  });

  it("shortens a file path to its last two segments", () => {
    expect(
      describeActivity(
        started({
          type: "fileRead",
          path: "/Users/someone/dev/project/lib/graph.ts",
          status: "pending",
        }),
      ),
    ).toBe("Reading lib/graph.ts");
  });

  it("describes the remaining kinds without a presentation", () => {
    const describe_ = (item: Record<string, unknown>) =>
      describeActivity(started({ status: "pending", ...item }));
    expect(describe_({ type: "search", query: "fanOutOver" })).toBe(
      "Searching fanOutOver",
    );
    expect(describe_({ type: "reasoning" })).toBe("Thinking");
    expect(describe_({ type: "plan" })).toBe("Planning");
    expect(describe_({ type: "contextCompaction" })).toBe("Compacting context");
    expect(describe_({ type: "backgroundTask", taskType: "build" })).toBe("build");
    expect(describe_({ type: "delegation", label: "Explore" })).toBe("Explore");
  });

  it("clamps a long line rather than letting it run past the node", () => {
    const line = describeActivity(
      started({
        type: "commandExecution",
        status: "pending",
        presentation: {
          icon: { glyph: "Terminal" },
          label: { pending: "Running command", completed: "Ran command" },
          title: "npm install --include=dev --cache /tmp/npm-cache --no-audit",
        },
      }),
    );
    expect(line).toHaveLength(44);
    expect(line).toMatch(/…$/u);
  });

  it("collapses the whitespace of a multi-line title", () => {
    expect(
      describeActivity(
        started({
          type: "commandExecution",
          status: "pending",
          presentation: {
            icon: { glyph: "Terminal" },
            label: { pending: "Running command", completed: "Ran command" },
            title: "git status\n  --short",
          },
        }),
      ),
    ).toBe("Running command: git status --short");
  });

  // The negative cases matter more than the positive ones here: a line that
  // says nothing would still overwrite the previous line, which did.
  it("says nothing about an item kind it does not know", () => {
    expect(
      describeActivity(started({ type: "somethingNew", status: "pending" })),
    ).toBeNull();
  });

  it("says nothing when the presentation carries only empty strings", () => {
    expect(
      describeActivity(
        started({
          type: "somethingNew",
          status: "pending",
          presentation: { icon: { glyph: "x" }, label: { pending: "  ", completed: "" } },
        }),
      ),
    ).toBeNull();
  });

  it("says nothing for an event without an item", () => {
    expect(describeActivity({ threadId: "thr_1" })).toBeNull();
    expect(describeActivity(undefined)).toBeNull();
    expect(describeActivity(null)).toBeNull();
    expect(describeActivity("item/started")).toBeNull();
  });
});

describe("elapsedLabel", () => {
  it("counts in minutes and seconds", () => {
    expect(elapsedLabel(0, 5_000)).toBe("0:05");
    expect(elapsedLabel(0, 252_000)).toBe("4:12");
    expect(elapsedLabel(1_000, 61_000)).toBe("1:00");
  });

  it("adds hours only once there are any", () => {
    expect(elapsedLabel(0, 3_723_000)).toBe("1:02:03");
    expect(elapsedLabel(0, 3_599_000)).toBe("59:59");
  });

  // A clock that runs backwards reads as a bug in the run, not in the clock.
  it("never goes negative when the clocks disagree", () => {
    expect(elapsedLabel(10_000, 0)).toBe("0:00");
  });
});

describe("activityByNode", () => {
  const attempt = (over: Partial<Parameters<typeof activityByNode>[0][number]>) => ({
    nodeId: "review",
    status: "running",
    startedAt: 1_000,
    activity: null,
    ...over,
  });

  it("reports a running attempt", () => {
    expect(activityByNode([attempt({ activity: "Thinking" })])).toEqual({
      review: { startedAt: 1_000, text: "Thinking" },
    });
  });

  it("ignores attempts that are no longer running", () => {
    expect(
      activityByNode([
        attempt({ status: "done", activity: "Ran vitest" }),
        attempt({ nodeId: "write", status: "failed" }),
      ]),
    ).toEqual({});
  });

  // A fanned-out node has one box and several workers. The newest branch is
  // the one whose line is least likely to be stale.
  it("lets the most recently started branch speak for a fanned-out node", () => {
    expect(
      activityByNode([
        attempt({ startedAt: 1_000, activity: "Reading a.ts" }),
        attempt({ startedAt: 9_000, activity: "Reading c.ts" }),
        attempt({ startedAt: 5_000, activity: "Reading b.ts" }),
      ]),
    ).toEqual({ review: { startedAt: 9_000, text: "Reading c.ts" } });
  });

  it("still reports a running attempt that has no line yet", () => {
    expect(activityByNode([attempt({ activity: null })])).toEqual({
      review: { startedAt: 1_000, text: null },
    });
  });
});

describe("durationByNode", () => {
  const run = (over: Partial<{ nodeId: string; status: string; startedAt: number | null; endedAt: number | null }>) => ({
    nodeId: "review", status: "done", startedAt: 0, endedAt: 65_000, ...over,
  });
  it("labels finished nodes with the time they ran", () => {
    expect(durationByNode([run({})])).toEqual({ review: "1:05" });
  });
  it("takes the latest attempt and skips running or incomplete ones", () => {
    expect(
      durationByNode([
        run({ startedAt: 100_000, endedAt: 103_000 }),
        run({}),
        run({ nodeId: "write", status: "running", endedAt: null }),
        run({ nodeId: "plan", endedAt: null }),
      ]),
    ).toEqual({ review: "0:03" });
  });
});
