// @vitest-environment jsdom
//
// The canvas during a long run.
//
// These are render-condition tests, and those need both directions: a check
// that something does *not* appear is green when it appears nowhere, which is
// the same result as a feature that was never wired up. So each rule below is
// pinned twice — once where it must show, once where it must not.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { graphSchema, type Graph } from "../lib/graph";
import { GraphCanvas, colorLightness } from "../components/graph-canvas";

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

describe("the canvas as an editor", () => {
  const connectable = (container: HTMLElement) =>
    container.querySelectorAll(".react-flow__handle.connectable").length;

  it("offers handles to draw an edge when it can take one", () => {
    const { container } = render(
      <GraphCanvas graph={graph()} onConnect={() => {}} />,
    );
    expect(connectable(container)).toBeGreaterThan(0);
  });

  it("offers none on a canvas that only shows a run", () => {
    const { container } = render(<GraphCanvas graph={graph()} />);
    expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0);
    expect(connectable(container)).toBe(0);
  });

  it("lets Start be selected where the terminals have a card", () => {
    render(<GraphCanvas graph={graph()} terminalsSelectable />);
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("keeps Start inert where it has nothing to show", () => {
    render(<GraphCanvas graph={graph()} />);
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });
});

/**
 * React Flow paints its chrome light unless told otherwise, which is what put
 * white surfaces into a dark BB. The mode is read from the theme's resolved
 * background, in whichever colour syntax the host resolves it to.
 */
describe("colorLightness", () => {
  it("reads a dark theme as dark", () => {
    expect(colorLightness("oklch(0.145 0 0)")).toBeLessThan(0.5);
    expect(colorLightness("rgb(20, 20, 20)")).toBeLessThan(0.5);
  });

  it("reads a light theme as light", () => {
    expect(colorLightness("oklch(1 0 0)")).toBeGreaterThan(0.5);
    expect(colorLightness("oklch(98% 0 0)")).toBeGreaterThan(0.5);
    expect(colorLightness("rgb(255, 255, 255)")).toBeGreaterThan(0.5);
  });

  it("admits it cannot tell rather than guessing", () => {
    expect(colorLightness("")).toBeNull();
    expect(colorLightness("transparent")).toBeNull();
  });
});

describe("the canvas's edge insert", () => {
  it("offers a + on each edge where the editor can splice", () => {
    render(<GraphCanvas graph={graph()} onInsertOnEdge={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Insert a node between explore and write" }),
    ).toBeTruthy();
  });

  it("offers none on a canvas that only shows a run", () => {
    render(<GraphCanvas graph={graph()} />);
    expect(screen.queryByRole("button", { name: /Insert a node/ })).toBeNull();
  });
});

describe("moving nodes", () => {
  const nodeEl = (container: HTMLElement, id: string) =>
    container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

  it("lets the editor drag nodes", () => {
    const { container } = render(<GraphCanvas graph={graph()} onMoveNode={() => {}} />);
    expect(nodeEl(container, "explore").classList.contains("draggable")).toBe(true);
  });

  it("keeps a run's nodes where they are", () => {
    const { container } = render(<GraphCanvas graph={graph()} />);
    expect(nodeEl(container, "explore").classList.contains("draggable")).toBe(false);
  });

  it("draws a node where its author put it", () => {
    const placed = { ...graph(), positions: { explore: { x: 512, y: 384 } } };
    const { container } = render(<GraphCanvas graph={placed} />);
    expect(nodeEl(container, "explore").style.transform).toContain("512px");
  });

  it("draws an unplaced node by the computed layout", () => {
    const { container } = render(<GraphCanvas graph={graph()} />);
    expect(nodeEl(container, "explore").style.transform).not.toContain("512px");
  });

  it("shows no library attribution in the corner", () => {
    const { container } = render(<GraphCanvas graph={graph()} />);
    expect(container.querySelector(".react-flow__attribution")).toBeNull();
  });
});

describe("a subgraph node as an import", () => {
  const child = graphSchema.parse({
    id: "child",
    name: "Child flow",
    nodes: [{ id: "inner", label: "Inner", kind: "agent", prompt: "x" }],
    edges: [
      { from: START, to: "inner" },
      { from: "inner", to: END },
    ],
  });
  const parent = graphSchema.parse({
    id: "parent",
    name: "Parent",
    nodes: [{ id: "sub", label: "Sub", kind: "subgraph", graphId: "child" }],
    edges: [
      { from: START, to: "sub" },
      { from: "sub", to: END },
    ],
  });

  it("names what it imports and opens it in place", () => {
    render(<GraphCanvas graph={parent} resolveGraph={(id) => (id === "child" ? child : null)} />);
    expect(screen.getByText(/imports Child flow/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the imported graph Child flow" }));
    expect(screen.getByRole("img", { name: "Imported graph Child flow" })).toBeTruthy();
  });

  it("offers nothing to open when the import cannot be resolved", () => {
    render(<GraphCanvas graph={parent} />);
    expect(screen.queryByRole("button", { name: /imported graph/ })).toBeNull();
  });
});


describe("user colour", () => {
  const coloured = (color: string | null) =>
    graphSchema.parse({
      id: "c",
      name: "Colour",
      nodes: [{ id: "a", label: "A", kind: "agent", prompt: "x", color }],
      edges: [{ from: START, to: "a" }, { from: "a", to: END }],
    });

  it("draws the chosen colour on the card", () => {
    render(<GraphCanvas graph={coloured("#46A758")} />);
    expect(screen.getByTestId("node-color").style.background).toContain("70, 167, 88");
  });

  it("draws no colour when none is chosen", () => {
    render(<GraphCanvas graph={coloured(null)} />);
    expect(screen.queryByTestId("node-color")).toBeNull();
  });
});
