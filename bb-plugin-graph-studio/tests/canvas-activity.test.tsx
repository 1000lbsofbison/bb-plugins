// @vitest-environment jsdom
//
// The canvas during a long run.
//
// These are render-condition tests, and those need both directions: a check
// that something does *not* appear is green when it appears nowhere, which is
// the same result as a feature that was never wired up. So each rule below is
// pinned twice — once where it must show, once where it must not.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { graphSchema, type Graph } from "../lib/graph";
import { GraphCanvas } from "../components/graph-canvas";

afterEach(cleanup);

const START = "__start__";
const END = "__end__";

const graph = (): Graph =>
  graphSchema.parse({
    id: "g",
    name: "Two steps",
    nodes: [
      // maxVisits 1 on purpose: the schema defaults it to 3, and with both
      // nodes on the default "max 3×" would be ambiguous in the assertions
      // below — which is the corner these tests are about.
      { id: "explore", label: "Explore", kind: "agent", prompt: "Look", maxVisits: 1 },
      { id: "write", label: "Write", kind: "agent", prompt: "Write", maxVisits: 3 },
    ],
    edges: [
      { from: START, to: "explore" },
      { from: "explore", to: "write" },
      { from: "write", to: END },
    ],
  });

/** The node's accessible name is the whole line a reader gets. */
const nodeLine = (label: string) =>
  screen
    .getAllByRole("button")
    .map((element) => element.getAttribute("aria-label") ?? "")
    .find((name) => name.startsWith(label)) ?? "";

describe("the canvas while a node runs", () => {
  it("shows what the worker is doing", () => {
    render(
      <GraphCanvas
        graph={graph()}
        statuses={{ explore: "running" }}
        activity={{ explore: { startedAt: 1_000, text: "Reading lib/graph.ts" } }}
        now={253_000}
      />,
    );
    // Twice in the DOM on purpose: the visible line, and the <title> that
    // carries the untruncated text as a tooltip.
    expect(screen.getAllByText("Reading lib/graph.ts").length).toBeGreaterThan(0);
    expect(nodeLine("Explore")).toContain("Reading lib/graph.ts");
  });

  it("says nothing under a node that has finished", () => {
    render(
      <GraphCanvas
        graph={graph()}
        statuses={{ explore: "done" }}
        // The server clears this itself, but a reload can still hand the panel
        // a line for a node that has meanwhile finished — the canvas must not
        // present the last tool call of a done node as the present tense.
        activity={{ explore: { startedAt: 1_000, text: "Reading lib/graph.ts" } }}
        now={253_000}
      />,
    );
    expect(screen.queryByText("Reading lib/graph.ts")).toBeNull();
  });

  it("counts the time the node has been running", () => {
    render(
      <GraphCanvas
        graph={graph()}
        statuses={{ explore: "running" }}
        activity={{ explore: { startedAt: 1_000, text: null } }}
        now={253_000}
      />,
    );
    expect(screen.getByText("4:12")).toBeTruthy();
  });

  it("shows no clock without a `now` to measure against", () => {
    render(
      <GraphCanvas
        graph={graph()}
        statuses={{ explore: "running" }}
        activity={{ explore: { startedAt: 1_000, text: null } }}
      />,
    );
    expect(screen.queryByText("4:12")).toBeNull();
  });

  // The clock and the visit limit share the node's bottom-right corner. While
  // a node runs, how long it has been going is the live question; how often it
  // may go round again is not — and afterwards it is the other way round.
  it("gives the visit limit's corner to the clock while the node runs", () => {
    render(
      <GraphCanvas
        graph={graph()}
        statuses={{ write: "running" }}
        activity={{ write: { startedAt: 0, text: null } }}
        now={65_000}
      />,
    );
    expect(screen.getByText("1:05")).toBeTruthy();
    expect(screen.queryByText("max 3×")).toBeNull();
  });

  it("gives it back once the node is no longer running", () => {
    render(<GraphCanvas graph={graph()} statuses={{ write: "done" }} now={65_000} />);
    expect(screen.getByText("max 3×")).toBeTruthy();
  });

  it("draws a plain graph with no run at all", () => {
    render(<GraphCanvas graph={graph()} />);
    expect(nodeLine("Explore")).toContain("open");
    expect(screen.queryByText(/^\d+:\d\d$/u)).toBeNull();
  });
});
