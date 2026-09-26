// @vitest-environment jsdom
//
// Regressions for "the export button ignores the first click": the export is
// read-only, so neither other in-flight work nor a still-loading library may
// swallow the click, and the output has to appear next to the button.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import { TEMPLATES } from "../lib/templates";
import { toGraphFile } from "../server";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(cleanup);

const mine = { ...TEMPLATES[0]!, id: "my-graph", name: "My Graph" };

function panel(overrides: Record<string, unknown> = {}) {
  return renderSlot(
    app.threadPanelActions[0]!,
    { threadId: "thr_1", params: null },
    {
      rpc: {
        listGraphs: () => ({ graphs: [mine, ...TEMPLATES], templates: TEMPLATES }),
        listRuns: () => ({ runs: [] }),
        listSkills: () => ({ skills: [], error: null }),
        exportGraph: ({ id }: { id: string }) => ({
          filename: `${id}.graph.json`,
          json: toGraphFile(mine),
        }),
        ...overrides,
      },
      context: { projectId: "proj_1", threadId: "thr_1" },
    },
  );
}

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

describe("export button", () => {
  it("exports while another action is still in flight", async () => {
    const start = gate();
    const slot = panel({
      startRun: async () => {
        await start.promise;
        return { run: { id: "run_1" } };
      },
    });
    fireEvent.change(await slot.findByLabelText("Task"), {
      target: { value: "tu was" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Start" }));

    fireEvent.click(slot.getByRole("button", { name: /as JSON/i }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "exportGraph"),
      ).toBe(true),
    );
    start.release();
  });

  it("says the library is loading instead of offering a dead button", async () => {
    const graphs = gate();
    const slot = panel({
      listGraphs: async () => {
        await graphs.promise;
        return { graphs: [mine, ...TEMPLATES], templates: TEMPLATES };
      },
    });
    expect(slot.queryByRole("button", { name: /as JSON/i })).toBeNull();
    expect(slot.getByText("Loading graphs …")).toBeTruthy();
    graphs.release();
    await slot.findByRole("button", { name: /as JSON/i });
  });

  it("shows the JSON inside the export section, not at the far end of the panel", async () => {
    const slot = panel();
    const button = await slot.findByRole("button", { name: /as JSON/i });
    const section = button.closest("details");
    expect(section).toBeTruthy();
    fireEvent.click(button);
    const output = await slot.findByLabelText("Exported JSON");
    expect(section!.contains(output)).toBe(true);
  });

  it("reports an export failure instead of staying silent", async () => {
    const slot = panel({
      exportGraph: () => {
        throw new Error("No such graph.");
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: /as JSON/i }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("No such graph.");
  });

  it("drops the output when leaving the screen it belongs to", async () => {
    const slot = panel();
    fireEvent.click(await slot.findByRole("button", { name: /as JSON/i }));
    await slot.findByLabelText("Exported JSON");
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(slot.queryByLabelText("Exported JSON")).toBeNull(),
    );
  });
});

/**
 * Editing an existing graph opens in full screen — the graph needs the room.
 * A new graph does not: its template picker and id live in the panel.
 */
describe("editor perspective", () => {
  const layer = () => document.body.querySelector('[role="dialog"][aria-label$="full screen"]');

  it("opens an existing graph straight into full screen", async () => {
    const slot = panel();
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(layer()).not.toBeNull());
  });

  it("starts a new graph in the panel", async () => {
    const slot = panel();
    fireEvent.click(await slot.findByRole("button", { name: /^New/ }));
    await slot.findByLabelText("Graph id");
    expect(layer()).toBeNull();
  });
});
