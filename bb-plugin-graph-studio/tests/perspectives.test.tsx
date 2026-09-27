// @vitest-environment jsdom
//
// The perspectives of the UX concept: the
// entry view, the run view and the inline card in the chat. Each rule pinned
// both ways — a card that shows nothing passes every "does not show" check.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import { TEMPLATES } from "../lib/templates";
import { suggestGraphs } from "../lib/suggest";

let app: CapturedPluginApp;
beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(cleanup);

const graph = TEMPLATES.find((entry) => entry.id === "concept-feature")!;
const firstNode = graph.nodes[0]!.id;

const makeRun = (overrides: Record<string, unknown> = {}) => ({
  id: "run_1",
  graphId: graph.id,
  graph,
  threadId: "thr_1",
  projectId: "proj_1",
  input: "A task",
  status: "done",
  state: { input: "A task", outputs: {}, fields: {}, visits: {}, steps: 2 },
  error: null,
  createdAt: 1,
  updatedAt: 2,
  nodeRuns: [
    {
      id: "nr_1",
      runId: "run_1",
      nodeId: firstNode,
      attempt: 1,
      status: "done",
      childThreadId: null,
      output: "First result",
      error: null,
      startedAt: 10,
      endedAt: 20,
      inputTokens: null,
      outputTokens: null,
      activity: null,
    },
  ],
  pendingQuestion: null,
  ...overrides,
});

function panel(rpc: Record<string, unknown> = {}) {
  return renderSlot(
    app.threadPanelActions[0]!,
    { threadId: "thr_1", params: null },
    {
      rpc: {
        listGraphs: () => ({ graphs: TEMPLATES, templates: TEMPLATES }),
        listRuns: () => ({ runs: [] }),
        listSkills: () => ({ skills: [], error: null }),
        listCheckpoints: () => ({ checkpoints: [] }),
        ...rpc,
      },
      context: { projectId: "proj_1", threadId: "thr_1" },
    },
  );
}

describe("suggestGraphs", () => {
  it("suggests a graph whose words the task shares", () => {
    const target = TEMPLATES.find((entry) => entry.example.length > 20)!;
    const words = target.example.split(/\s+/).filter((word) => word.length >= 6).slice(0, 3);
    expect(suggestGraphs(TEMPLATES, words.join(" "), 10).map((entry) => entry.id)).toContain(
      target.id,
    );
  });

  it("suggests nothing for a task that shares nothing", () => {
    expect(suggestGraphs(TEMPLATES, "zzqx vvbw")).toEqual([]);
    expect(suggestGraphs(TEMPLATES, "")).toEqual([]);
  });
});

describe("entry view", () => {
  it("puts a run that waits for an answer at the top", async () => {
    const slot = panel({
      listRuns: () => ({
        runs: [
          makeRun({
            status: "waiting-human",
            pendingQuestion: { nodeId: firstNode, label: "x", question: "Go?" },
          }),
        ],
      }),
    });
    expect(await slot.findByText("Active")).toBeTruthy();
  });

  it("has no Active section when nothing is running", async () => {
    const slot = panel({ listRuns: () => ({ runs: [makeRun()] }) });
    await slot.findByText("Runs");
    expect(slot.queryByText("Active")).toBeNull();
  });

  it("offers graphs that fit the typed task", async () => {
    const slot = panel();
    const target = TEMPLATES.find((entry) => entry.example.length > 20 && entry.id !== TEMPLATES[0]!.id)!;
    fireEvent.change(await slot.findByLabelText("Task"), {
      target: { value: target.example },
    });
    expect(await slot.findByText("Fits the task:")).toBeTruthy();
  });

  it("offers none before a task is typed", async () => {
    const slot = panel();
    await slot.findByLabelText("Task");
    expect(slot.queryByText("Fits the task:")).toBeNull();
  });
});

describe("run view", () => {
  const openRun = async (run: Record<string, unknown>, checkpoints: unknown[] = []) => {
    const slot = panel({
      listRuns: () => ({ runs: [run] }),
      listCheckpoints: () => ({ checkpoints }),
    });
    fireEvent.click(await slot.findByText(/A task/));
    return slot;
  };

  it("shows each visit on the timeline and opens its attempt", async () => {
    const slot = await openRun(makeRun());
    const tick = await slot.findByRole("button", {
      name: new RegExp(`attempt 1, done`),
    });
    fireEvent.click(tick);
    expect(await slot.findByText("First result")).toBeTruthy();
    expect(slot.getByRole("tab", { name: "Attempts · 1" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("offers restart points on the timeline for a stopped run", async () => {
    const slot = await openRun(makeRun(), [
      { checkpointId: "cp_1", next: [firstNode], doneCount: 0 },
    ]);
    expect(await slot.findByRole("button", { name: /^Restart before/ })).toBeTruthy();
  });

  it("offers none while the run is moving", async () => {
    const slot = await openRun(makeRun({ status: "running" }), [
      { checkpointId: "cp_1", next: [firstNode], doneCount: 0 },
    ]);
    await slot.findByRole("button", { name: /attempt 1/ });
    expect(slot.queryByRole("button", { name: /^Restart before/ })).toBeNull();
  });
});

describe("inline run card", () => {
  const card = (run: unknown, attributes: Record<string, string> = { run: "run_1" }) =>
    renderSlot(
      app.messageDirectives[0]!,
      {
        attributes,
        source: `::graph-run{run="${attributes.run ?? ""}"}`,
        message: { id: "m1", threadId: "thr_1", turnId: null, projectId: "proj_1" },
        openWorkspaceFile: null,
      },
      { rpc: { getRun: () => ({ run }) }, context: { projectId: "proj_1", threadId: "thr_1" } },
    );

  it("is registered as the graph-run directive", () => {
    expect(app.messageDirectives.map((entry) => entry.id)).toContain("graph-run");
  });

  it("shows the run with the question it waits on", async () => {
    const slot = card(
      makeRun({
        status: "waiting-human",
        pendingQuestion: { nodeId: firstNode, label: "Approval", question: "Ship it?" },
      }),
    );
    expect(await slot.findByLabelText("Answer to the approval")).toBeTruthy();
    expect(slot.getByText(/waiting for you/)).toBeTruthy();
  });

  it("asks nothing of a finished run", async () => {
    const slot = card(makeRun());
    await slot.findByText(/done · 1 done/);
    expect(slot.queryByLabelText("Answer to the approval")).toBeNull();
  });

  it("refuses an attribute that is not a run id", async () => {
    const slot = card(makeRun(), { run: "../../etc" });
    await waitFor(() => expect(slot.getByText(/names no run/)).toBeTruthy());
  });
});
