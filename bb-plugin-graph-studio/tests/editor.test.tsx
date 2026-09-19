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
import { cleanup, fireEvent, screen } from "@testing-library/react";
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
      expect(screen.getByText("Default")).toBeTruthy();
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
