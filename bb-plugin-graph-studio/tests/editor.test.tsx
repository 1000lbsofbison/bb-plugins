// @vitest-environment jsdom
//
// Regression: pressing "Neu" crashed the panel. The empty draft was built with
// `graphSchema.parse({ id: "", ... })`, and an empty id fails the id regex, so
// the editor threw a ZodError during its first render — before the user could
// ever type an id.
//
// Rendered through `renderSlot` rather than plain `render`: the editor now
// hosts BB's own provider/model picker, and the SDK hooks behind it only exist
// inside a plugin app. `renderSlot` supplies that context for a single
// component, so these stay fast unit tests instead of loading the bundle.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { GraphEditor } from "../components/graph-editor";
import { TEMPLATES } from "../lib/templates";

afterEach(cleanup);

const noop = () => {};

/** One registered provider, so "Festlegen" has something to seed itself with. */
const providers = {
  providers: {
    status: "ready" as const,
    providers: [{ id: "claude-code", displayName: "Claude Code" }] as never,
  },
};

function editor(props: Record<string, unknown>) {
  return renderSlot({ component: GraphEditor as never }, props, providers);
}

describe("GraphEditor", () => {
  it("renders a blank draft without throwing", () => {
    expect(() =>
      editor({
        graphs: [],
        templates: TEMPLATES,
        graphId: null,
        pending: false,
        onSave: noop,
        onCancel: noop,
        onClone: noop,
        onDelete: noop,
      }),
    ).not.toThrow();
  });

  /**
   * The template list is where somebody browses the catalogue on purpose, so
   * it carries the same fine headings as the run picker. Asserted positively:
   * a check that the coarse label is *gone* would also pass if the dropdown
   * rendered no headings at all.
   */
  it("shows the fine catalogue headings over the template list", () => {
    const slot = editor({
      graphs: [],
      templates: TEMPLATES,
      graphId: null,
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
    const labels = [...slot.container.querySelectorAll("optgroup")].map(
      (group) => group.label,
    );
    expect(labels).toContain("Patterns — one step after another");
    expect(labels).toContain("Work — building");
    expect(labels).not.toContain("Patterns — established flows");
  });

  it("keeps Save disabled until a valid id is typed, then saves", () => {
    const onSave = vi.fn();
    editor({
      graphs: [],
      templates: TEMPLATES,
      graphId: null,
      pending: false,
      onSave,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });

    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Graph id"), {
      target: { value: "my-graph" },
    });
    fireEvent.change(screen.getByLabelText("Graph name"), {
      target: { value: "My Graph" },
    });

    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      id: "my-graph",
      name: "My Graph",
    });
  });

  it("reports the blank draft as not yet runnable instead of crashing", () => {
    editor({
      graphs: [],
      templates: TEMPLATES,
      graphId: null,
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
    // An empty id and name are problems the user can see and fix, not a crash.
    expect(screen.getByLabelText("Graph id")).toHaveProperty("value", "");
  });

  it("shows the clone once the editor is pointed at it (remount)", () => {
    // Mirrors the panel's `key`: after cloning, the editor is re-created for
    // the new id. Without that remount the stale blank draft stayed on screen.
    const clone = { ...TEMPLATES[0]!, id: "meine-kopie", name: "Meine Kopie" };
    const props = {
      templates: TEMPLATES,
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    };
    const { lifecycle } = editor({ graphs: [], graphId: null, ...props });
    expect((screen.getByLabelText("Graph id") as HTMLInputElement).value).toBe("");

    lifecycle.rerender(
      <GraphEditor
        key="meine-kopie"
        graphs={[clone]}
        graphId="meine-kopie"
        {...props}
      />,
    );
    expect((screen.getByLabelText("Graph id") as HTMLInputElement).value).toBe(
      "meine-kopie",
    );
    expect((screen.getByLabelText("Graph name") as HTMLInputElement).value).toBe(
      "Meine Kopie",
    );
  });

  it("loads an existing graph and locks its id", () => {
    const existing = TEMPLATES[0]!;
    editor({
      graphs: [existing],
      templates: TEMPLATES,
      graphId: existing.id,
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
    const id = screen.getByLabelText("Graph id") as HTMLInputElement;
    expect(id.value).toBe(existing.id);
    expect(id.disabled).toBe(true);
  });

  /**
   * Per-node model choice. The interesting cases are the ones where nothing
   * crashes: a selection that looks made but is dropped on the way to
   * `threads.spawn`, and a setting folded into a collapsed section where
   * nobody would see it.
   */
  describe("model choice", () => {
    const open = () => {
      editor({
        graphs: [],
        templates: TEMPLATES,
        graphId: null,
        pending: false,
        onSave: noop,
        onCancel: noop,
        onClone: noop,
        onDelete: noop,
      });
      return screen.getByLabelText("Model choice of node 1") as HTMLSelectElement;
    };

    it("inherits by default and offers no picker until asked", () => {
      const choice = open();
      expect(choice.value).toBe("inherit");
      expect(screen.queryByLabelText("Model")).toBeNull();
    });

    it("shows the picker once a node is set to choose for itself", () => {
      const choice = open();
      fireEvent.change(choice, { target: { value: "explicit" } });
      expect(screen.getByLabelText("Provider ID")).toHaveProperty(
        "value",
        "claude-code",
      );
      // Seeded with a provider but no model — and that half state must announce
      // itself rather than quietly running on the inherited model.
      expect(
        screen.getByText(/Provider and model belong together/),
      ).toBeTruthy();
    });

    it("writes a complete selection into the graph and back to inheriting", () => {
      const onSave = vi.fn();
      editor({
        graphs: [],
        templates: TEMPLATES,
        graphId: null,
        pending: false,
        onSave,
        onCancel: noop,
        onClone: noop,
        onDelete: noop,
      });
      fireEvent.change(screen.getByLabelText("Graph id"), {
        target: { value: "my-graph" },
      });
      fireEvent.change(screen.getByLabelText("Graph name"), {
        target: { value: "My Graph" },
      });
      fireEvent.change(screen.getByLabelText("Model choice of node 1"), {
        target: { value: "explicit" },
      });
      fireEvent.change(screen.getByLabelText("Model"), {
        target: { value: "claude-opus-5" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Apply execution selection" }),
      );

      // Saving is only possible because the selection is now complete; a
      // half-filled one is a blocking validation error.
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(onSave.mock.calls[0]![0].nodes[0]).toMatchObject({
        providerId: "claude-code",
        model: "claude-opus-5",
      });

      fireEvent.change(screen.getByLabelText("Model choice of node 1"), {
        target: { value: "inherit" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(onSave.mock.calls[1]![0].nodes[0]).toMatchObject({
        providerId: null,
        model: null,
        reasoningLevel: null,
      });
    });

    // A folded-away setting is a setting nobody sees. The summary is the only
    // thing standing between "configured" and "silently configured".
    it("names the chosen model in the collapsed summary", () => {
      open();
      fireEvent.change(screen.getByLabelText("Model choice of node 1"), {
        target: { value: "explicit" },
      });
      fireEvent.change(screen.getByLabelText("Model"), {
        target: { value: "claude-opus-5" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Apply execution selection" }),
      );
      expect(screen.getAllByText("claude-opus-5").length).toBeGreaterThan(0);
    });

    it("says Default when a node deviates in nothing", () => {
      open();
      expect(screen.getAllByText("Default").length).toBeGreaterThan(0);
    });
  });
});

/**
 * Roadmap #13 shipped the engine without a way to reach it: `routing` was only
 * settable by importing JSON, so a graph built in the editor could never use
 * the inclusive or. These tests are what say the editor can now reach it — and
 * what say it stays out of the way where it would mean nothing.
 */
describe("GraphEditor > routing", () => {
  const withEdges = (count: number) => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
    nodes: [
      { ...TEMPLATES[0]!.nodes[0]!, id: "a" },
      { ...TEMPLATES[0]!.nodes[0]!, id: "b" },
      { ...TEMPLATES[0]!.nodes[0]!, id: "c" },
    ],
    edges: [
      { from: "__start__", to: "a", when: null, label: "", fanOutOver: "" },
      { from: "a", to: "b", when: null, label: "", fanOutOver: "" },
      ...(count > 1
        ? [{ from: "a", to: "c", when: null, label: "", fanOutOver: "" }]
        : []),
      { from: "b", to: "__end__", when: null, label: "", fanOutOver: "" },
    ],
  });

  const open = (graph: unknown) =>
    editor({
      graphs: [graph],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });

  it("offers the choice on a node that has somewhere to choose between", () => {
    open(withEdges(2));
    const select = screen.getByLabelText("Routing of node 1") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "first",
      "every",
    ]);
    expect(select.value).toBe("first");
  });

  /**
   * The negative case. One way out means the setting changes nothing, and a
   * dropdown that does nothing teaches that it never does.
   */
  it("stays away from a node with a single outgoing edge", () => {
    open(withEdges(1));
    expect(screen.queryByLabelText("Routing of node 1")).toBeNull();
  });

  it("saves the switch to `every`", () => {
    const onSave = vi.fn();
    editor({
      graphs: [withEdges(2)],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
    fireEvent.change(screen.getByLabelText("Routing of node 1"), {
      target: { value: "every" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalled();
    const saved = onSave.mock.calls[0]![0] as { nodes: Array<{ routing: string }> };
    expect(saved.nodes[0]!.routing).toBe("every");
  });

  /**
   * `every` opens branches that cannot be merged again. Saying so next to the
   * switch is cheaper than discovering it in a run that hangs.
   */
  it("warns next to the switch that the branches cannot be joined", () => {
    const graph = withEdges(2);
    graph.nodes[0] = { ...graph.nodes[0]!, routing: "every" } as never;
    open(graph);
    expect(screen.getByText(/cannot be merged again/)).toBeTruthy();
  });

  it("says nothing of the sort while the node is on `first`", () => {
    open(withEdges(2));
    expect(screen.queryByText(/cannot be merged again/)).toBeNull();
  });
});

/**
 * Roadmap #16 has the same shape as #13 before it: the engine can route a
 * failure, and without a control for it the setting would only be reachable by
 * importing JSON. The negative cases say it stays away where it would mean
 * nothing — and that the outcome conditions do not ask for a search text they
 * never read.
 */
describe("GraphEditor > routing a failure", () => {
  const probe = (node: Record<string, unknown>, edge: Record<string, unknown> = {}) => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
    nodes: [
      { ...TEMPLATES[0]!.nodes[0]!, id: "a", ...node },
      { ...TEMPLATES[0]!.nodes[0]!, id: "b" },
    ],
    edges: [
      { from: "__start__", to: "a", when: null, label: "", fanOutOver: "" },
      { from: "a", to: "b", when: null, label: "", fanOutOver: "", ...edge },
      { from: "b", to: "__end__", when: null, label: "", fanOutOver: "" },
    ],
  });

  const open = (graph: unknown, onSave: () => void = noop) =>
    editor({
      graphs: [graph],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });

  it("offers the choice on a node that spawns a worker", () => {
    open(probe({}));
    const select = screen.getByLabelText(
      "Failure handling of node 1",
    ) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "stop",
      "route",
    ]);
    expect(select.value).toBe("stop");
  });

  it("stays away from a node that cannot fail", () => {
    open(probe({ kind: "note" }));
    expect(screen.queryByLabelText("Failure handling of node 1")).toBeNull();
  });

  it("saves the switch to routing the failure", () => {
    const onSave = vi.fn();
    open(probe({}), onSave);
    fireEvent.change(screen.getByLabelText("Failure handling of node 1"), {
      target: { value: "route" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved = onSave.mock.calls[0]![0] as { nodes: Array<{ onError: string }> };
    expect(saved.nodes[0]!.onError).toBe("route");
  });

  // The collapsed section has to admit to it, like every other setting that
  // changes what a run does while being folded out of sight.
  it("names it in the collapsed summary", () => {
    open(probe({ onError: "route" }));
    expect(screen.getAllByText(/routes its failure/).length).toBeGreaterThan(0);
  });

  it("asks which node a failure condition is about, and for no search text", () => {
    open(
      probe(
        { onError: "route" },
        { when: { source: "output", key: "", op: "failed", value: "" } },
      ),
    );
    expect(screen.getByLabelText("Subject of edge 2")).toBeTruthy();
    expect(screen.queryByLabelText("Comparison value of edge 2")).toBeNull();
  });

  it("still asks for one on a condition that reads text", () => {
    open(
      probe({}, { when: { source: "output", key: "", op: "contains", value: "ok" } }),
    );
    expect(screen.getByLabelText("Comparison value of edge 2")).toBeTruthy();
  });
});

/**
 * Roadmap #17. The control is offered only where there is a field it could
 * read, and the choice form is listed first because it is the one that keeps
 * the canvas able to draw and the validator able to check.
 */
describe("GraphEditor > taking the target from a field", () => {
  const withFields = (fields: unknown[]) => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
    nodes: [
      { ...TEMPLATES[0]!.nodes[0]!, id: "a", fields },
      { ...TEMPLATES[0]!.nodes[0]!, id: "b", fields: [] },
    ],
    edges: [
      { from: "__start__", to: "a", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "a", to: "b", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "b", to: "__end__", when: null, label: "", fanOutOver: "", handoffFrom: "" },
    ],
  });

  const open = (graph: unknown, onSave: () => void = noop) =>
    editor({
      graphs: [graph],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });

  it("offers the fields a target could come from, choice first", () => {
    open(
      withFields([
        { name: "next", type: "enum", options: ["b"], description: "" },
        { name: "note", type: "string", options: [], description: "" },
      ]),
    );
    const select = screen.getByLabelText("Handoff of edge 2") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "__none__",
      "a.next",
      "a.note",
    ]);
  });

  /** No field it could read means the dropdown would only ever say "no". */
  it("stays away when no field could name a target", () => {
    open(withFields([{ name: "count", type: "number", options: [], description: "" }]));
    expect(screen.queryByLabelText("Handoff of edge 2")).toBeNull();
  });

  it("saves the chosen field onto the edge", () => {
    const onSave = vi.fn();
    open(
      withFields([{ name: "next", type: "enum", options: ["b"], description: "" }]),
      onSave,
    );
    fireEvent.change(screen.getByLabelText("Handoff of edge 2"), {
      target: { value: "a.next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved = onSave.mock.calls[0]![0] as { edges: Array<{ handoffFrom: string }> };
    expect(saved.edges[1]!.handoffFrom).toBe("a.next");
  });
});

/**
 * Editing in the graph. Nodes and edges used to be two separate lists; now a
 * node's card holds its settings and exactly its own edges. Each rule is
 * pinned both ways, since a card that shows nothing would pass every
 * "does not show" check.
 */
describe("GraphEditor > node card", () => {
  const probe = () => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
    nodes: [
      { ...TEMPLATES[0]!.nodes[0]!, id: "a", label: "Alpha" },
      { ...TEMPLATES[0]!.nodes[0]!, id: "b", label: "Beta" },
    ],
    edges: [
      { from: "__start__", to: "a", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "a", to: "b", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "b", to: "__end__", when: null, label: "", fanOutOver: "", handoffFrom: "" },
    ],
  });

  const open = (onSave: () => void = noop) =>
    editor({
      graphs: [probe()],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });

  const pick = (label: string) => {
    const picker = screen.getByLabelText("Edit node") as HTMLSelectElement;
    const option = [...picker.options].find((entry) =>
      entry.text.startsWith(label),
    )!;
    fireEvent.change(picker, { target: { value: option.value } });
  };

  it("opens on the first node with its incoming and outgoing edges", () => {
    open();
    expect(screen.getByLabelText("Id of node 1")).toBeTruthy();
    expect(screen.getByLabelText("Source of edge 1")).toBeTruthy();
    expect(screen.getByLabelText("Source of edge 2")).toBeTruthy();
  });

  it("leaves out edges that do not touch the node", () => {
    open();
    expect(screen.queryByLabelText("Source of edge 3")).toBeNull();
    expect(screen.queryByLabelText("Id of node 2")).toBeNull();
  });

  it("switches to another node's card and its edges", () => {
    open();
    pick("Beta");
    expect(screen.getByLabelText("Id of node 2")).toBeTruthy();
    expect(screen.getByLabelText("Source of edge 3")).toBeTruthy();
    expect(screen.queryByLabelText("Source of edge 1")).toBeNull();
  });

  it("shows Start's outgoing edges and no node settings", () => {
    open();
    pick("Start");
    expect(screen.getByLabelText("Source of edge 1")).toBeTruthy();
    expect(screen.queryByLabelText(/^Id of node/)).toBeNull();
  });

  it("adds an outgoing edge from the card", () => {
    const onSave = vi.fn();
    open(onSave);
    fireEvent.click(screen.getByRole("button", { name: "Outgoing" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved = onSave.mock.calls[0]![0] as { edges: Array<{ from: string; to: string }> };
    expect(saved.edges).toHaveLength(4);
    expect(saved.edges[3]).toMatchObject({ from: "a", to: "__end__" });
  });

  it("takes the edges along when a node is renamed", () => {
    const onSave = vi.fn();
    open(onSave);
    fireEvent.change(screen.getByLabelText("Id of node 1"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved = onSave.mock.calls[0]![0] as { edges: Array<{ from: string; to: string }> };
    expect(saved.edges[0]!.to).toBe("first");
    expect(saved.edges[1]!.from).toBe("first");
  });

  /**
   * Renaming onto another node's id is a typo in progress, not a merge — and
   * the keystroke after it must not carry the other node's edges off either.
   */
  it("leaves the edges alone while the id collides with another node", () => {
    open();
    const id = screen.getByLabelText("Id of node 1");
    fireEvent.change(id, { target: { value: "b" } });
    fireEvent.change(id, { target: { value: "c" } });
    // Node 1's edges were not moved onto "b", so they name the vanished "a"
    // and land in the list where they can still be reached and fixed.
    expect(screen.getByText("Edges pointing at no node")).toBeTruthy();
    // Beta kept its own way to End instead of handing it to "c".
    pick("Beta");
    expect(
      (screen.getByLabelText("Source of edge 3") as HTMLSelectElement).value,
    ).toBe("b");
  });

  it("has no stray list while every edge names a node", () => {
    open();
    expect(screen.queryByText("Edges pointing at no node")).toBeNull();
  });
});

/**
 * Full screen in the editor: the graph takes the window, and the node card
 * moves into a sidebar beside it instead of queueing up underneath.
 */
describe("GraphEditor > full screen", () => {
  const open = () =>
    editor({
      graphs: [TEMPLATES[0]!],
      templates: TEMPLATES,
      graphId: TEMPLATES[0]!.id,
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
  const layer = () => screen.queryByRole("dialog", { name: /full screen/ });

  it("is closed until asked for", () => {
    open();
    expect(layer()).toBeNull();
  });

  it("opens over the window with the node card in its sidebar", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    const opened = layer()!;
    expect(opened).not.toBeNull();
    expect(opened.parentElement).toBe(document.body);
    expect(within(opened).getByLabelText("Id of node 1")).toBeTruthy();
    expect(within(opened).getByRole("button", { name: "Save" })).toBeTruthy();
    // One card, not a second copy left behind in the panel.
    expect(screen.getAllByLabelText("Id of node 1")).toHaveLength(1);
  });

  it("closes with Escape", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(layer()).toBeNull();
    expect(screen.getByLabelText("Id of node 1")).toBeTruthy();
  });
});

describe("GraphEditor > edge rows", () => {
  const probe = () => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
    nodes: [
      { ...TEMPLATES[0]!.nodes[0]!, id: "a", label: "Alpha" },
      { ...TEMPLATES[0]!.nodes[0]!, id: "b", label: "Beta" },
    ],
    edges: [
      { from: "__start__", to: "a", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "a", to: "b", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "b", to: "__end__", when: null, label: "", fanOutOver: "", handoffFrom: "" },
    ],
  });
  const open = () => {
    editor({
      graphs: [probe()],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
  };

  it("jumps to the node at the other end", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Go to Beta" }));
    expect(screen.getByLabelText("Id of node 2")).toBeTruthy();
    expect(screen.queryByLabelText("Id of node 1")).toBeNull();
  });

  it("names each edge's other end in its folded line", () => {
    open();
    expect(screen.getByRole("button", { name: "Go to Start" })).toBeTruthy();
    // Node 1 has no edge to End, so there is nothing to jump there.
    expect(screen.queryByRole("button", { name: "Go to End" })).toBeNull();
  });
});

/**
 * The reported "error" on switching a node to Subgraph: nothing crashed, but
 * the validator raised problems the card gave no way to fix (a hidden prompt)
 * and no explanation of what the kind does.
 */
describe("GraphEditor > subgraph node", () => {
  const withKind = (kind: string, extra: Record<string, unknown> = {}) => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
    nodes: [
      { ...TEMPLATES[0]!.nodes[0]!, id: "a", label: "Alpha", kind, ...extra },
      { ...TEMPLATES[0]!.nodes[0]!, id: "b", label: "Beta", prompt: "Go" },
    ],
    edges: [
      { from: "__start__", to: "a", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "a", to: "b", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "b", to: "__end__", when: null, label: "", fanOutOver: "", handoffFrom: "" },
    ],
  });
  const open = (graph: unknown, onSave: () => void = noop) =>
    editor({
      graphs: [graph],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });

  it("explains what the kind does", () => {
    open(withKind("subgraph", { prompt: "" }));
    expect(screen.getByText(/What a subgraph does/)).toBeTruthy();
  });

  it("says nothing of the sort on an agent", () => {
    open(withKind("agent"));
    expect(screen.queryByText(/What a subgraph does/)).toBeNull();
  });

  it("shows the node's own problem in its card", () => {
    open(withKind("subgraph", { prompt: "", graphId: "" }));
    const card = screen.getByLabelText("Node Alpha");
    expect(within(card as HTMLElement).getByText(/names no graph/)).toBeTruthy();
  });

  it("offers to clear a prompt left over from the previous kind", () => {
    const onSave = vi.fn();
    open(
      withKind("subgraph", { prompt: "Old instruction", graphId: TEMPLATES[1]!.id }),
      onSave,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear them" }));
    expect(screen.queryByRole("button", { name: "Clear them" })).toBeNull();
  });

  it("offers nothing to clear when nothing is left over", () => {
    open(withKind("subgraph", { prompt: "", graphId: TEMPLATES[1]!.id }));
    expect(screen.queryByRole("button", { name: "Clear them" })).toBeNull();
  });

  it("lists the ids the embedded graph makes readable", () => {
    const child = TEMPLATES[1]!;
    open(withKind("subgraph", { prompt: "", graphId: child.id }));
    expect(screen.getByText(`{{${child.nodes[0]!.id}}}`)).toBeTruthy();
  });
});

describe("GraphEditor > full screen sidebar", () => {
  it("shows the graph's settings when no node is selected", () => {
    editor({
      graphs: [TEMPLATES[0]!],
      templates: TEMPLATES,
      graphId: TEMPLATES[0]!.id,
      pending: false,
      startFullscreen: true,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
    const layer = screen.getByRole("dialog", { name: /full screen/ });
    expect(within(layer).queryByLabelText("Graph name")).toBeNull();
    fireEvent.change(within(layer).getByLabelText("Edit node"), {
      target: { value: "" },
    });
    expect(within(layer).getByLabelText("Graph name")).toBeTruthy();
  });
});

describe("GraphEditor > card tabs, kinds, history, leaving, inserting", () => {
  const probe = () => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
    nodes: [
      { ...TEMPLATES[0]!.nodes[0]!, id: "a", label: "Alpha", kind: "agent" },
      { ...TEMPLATES[0]!.nodes[0]!, id: "b", label: "Beta", kind: "agent" },
    ],
    edges: [
      { from: "__start__", to: "a", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "a", to: "b", when: null, label: "", fanOutOver: "", handoffFrom: "" },
      { from: "b", to: "__end__", when: null, label: "", fanOutOver: "", handoffFrom: "" },
    ],
  });
  const open = (props: Record<string, unknown> = {}) =>
    editor({
      graphs: [probe()],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
      ...props,
    });

  // No block of facts above the sections: the folded sections' summaries
  // are the overview.
  it("folds every section and says what is set in its summary", () => {
    open();
    const card = screen.getByLabelText("Node Alpha");
    const sections = [...card.querySelectorAll("details")].filter(
      (entry) => entry.parentElement === card,
    );
    expect(sections.length).toBeGreaterThan(3);
    expect(sections.every((entry) => !entry.open)).toBe(true);
    const model = sections.find((entry) => entry.textContent?.startsWith("Model"))!;
    expect(within(model.querySelector("summary")!).getByText("inherited")).toBeTruthy();
    expect(within(card).queryByText("inherited from the thread")).toBeNull();
  });

  it("names a chosen model there instead of the inherited one", () => {
    const graph = probe();
    graph.nodes[0] = {
      ...graph.nodes[0]!,
      providerId: "claude-code",
      model: "claude-opus-5",
    } as never;
    editor({
      graphs: [graph],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave: noop,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });
    const card = screen.getByLabelText("Node Alpha");
    const model = [...card.querySelectorAll("summary")].find((entry) =>
      entry.textContent?.startsWith("Model"),
    )!;
    expect(model.textContent).toContain("claude-opus-5");
    expect(model.textContent).not.toContain("inherited");
  });

  it("switches the kind with its button", () => {
    const onSave = vi.fn();
    open({ onSave });
    const kinds = screen.getByRole("radiogroup", { name: "Kind of node 1" });
    expect(
      within(kinds).getByRole("radio", { name: /Agent/ }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(kinds).getByRole("radio", { name: /Note/ }));
    expect(
      within(kinds).getByRole("radio", { name: /Note/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(kinds).getByRole("radio", { name: /Agent/ }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("offers nothing to undo before anything changed", () => {
    open();
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("undoes and redoes a change", () => {
    open();
    const label = screen.getByLabelText("Label of node 1") as HTMLInputElement;
    fireEvent.change(label, { target: { value: "Renamed" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByLabelText("Label of node 1") as HTMLInputElement).value).toBe("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect((screen.getByLabelText("Label of node 1") as HTMLInputElement).value).toBe("Renamed");
  });

  it("leaves at once when nothing changed", () => {
    const onCancel = vi.fn();
    open({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("asks before dropping unsaved changes", () => {
    const onCancel = vi.fn();
    open({ onCancel });
    fireEvent.change(screen.getByLabelText("Label of node 1"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Unsaved changes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("splices a node into an edge, keeping both ends", () => {
    const onSave = vi.fn();
    open({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Insert a node between a and b" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved = onSave.mock.calls[0]![0] as {
      nodes: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    const added = saved.nodes[2]!.id;
    expect(saved.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      "__start__>a",
      `a>${added}`,
      `${added}>b`,
      "b>__end__",
    ]);
  });
});

describe("GraphEditor > positions", () => {
  const base = () => ({
    ...TEMPLATES[0]!,
    id: "probe",
    name: "Probe",
  });
  const open = (graph: unknown, onSave: () => void = noop) =>
    editor({
      graphs: [graph],
      templates: TEMPLATES,
      graphId: "probe",
      pending: false,
      onSave,
      onCancel: noop,
      onClone: noop,
      onDelete: noop,
    });

  it("offers Auto layout once nodes were placed, and it forgets the places", () => {
    const onSave = vi.fn();
    open({ ...base(), positions: { [TEMPLATES[0]!.nodes[0]!.id]: { x: 10, y: 20 } } }, onSave);
    fireEvent.click(screen.getByRole("button", { name: "Auto layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave.mock.calls[0]![0].positions).toEqual({});
  });

  it("offers no Auto layout while the layout is computed anyway", () => {
    open({ ...base(), positions: {} });
    expect(screen.queryByRole("button", { name: "Auto layout" })).toBeNull();
  });
});
