// @vitest-environment jsdom
//
// The banner above the composer is the route back from a chat to the graph it
// started. With several windows side by side the panel alone cannot say which
// conversation it belongs to, so these tests pin the two things that make the
// route trustworthy: it appears only for *this* thread's live runs, and the
// click carries the run it was showing.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import { TEMPLATES } from "../lib/templates";
import type { RunDto } from "../server";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(cleanup);

const graph = TEMPLATES.find((entry) => entry.id === "concept-feature")!;

function makeRun(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run_1",
    graphId: graph.id,
    graph,
    threadId: "thr_1",
    projectId: "proj_1",
    input: "A task",
    status: "running",
    state: { input: "A task", outputs: {}, fields: {}, visits: {}, steps: 0 },
    error: null,
    createdAt: 1,
    updatedAt: 2,
    nodeRuns: [],
    pendingQuestion: null,
    ...overrides,
  };
}

function banner(runs: RunDto[]) {
  const customization = app.composerCustomizations[0]!;
  const registration = customization.banners![0]!;
  return renderSlot(
    registration,
    {},
    {
      rpc: { listRuns: () => ({ runs }) },
      context: { projectId: "proj_1", threadId: "thr_1" },
    },
  );
}

describe("run banner", () => {
  it("is registered for the thread composer", () => {
    const customization = app.composerCustomizations[0]!;
    expect(customization.banners).toHaveLength(1);
    expect(customization.scopes).toEqual(["thread"]);
  });

  it("stays out of the way when nothing is running", async () => {
    const slot = banner([
      makeRun({ id: "run_done", status: "done" }),
      makeRun({ id: "run_failed", status: "failed" }),
    ]);
    await waitFor(() => expect(slot.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.container.textContent).toBe("");
  });

  it("shows the live graph in place and remembers when it is hidden", async () => {
    localStorage.removeItem("graph-studio:run-banner-collapsed");
    const slot = banner([makeRun()]);
    const toggle = await slot.findByRole("button", { name: "Hide the graph" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(await slot.findByRole("button", { name: "Show the graph" })).toBeTruthy();
    expect(localStorage.getItem("graph-studio:run-banner-collapsed")).toBe("1");
    localStorage.removeItem("graph-studio:run-banner-collapsed");
  });

  it("names the node a running graph is on", async () => {
    const slot = banner([
      makeRun({
        nodeRuns: [
          {
            id: "nr_1",
            runId: "run_1",
            nodeId: "draft",
            attempt: 1,
            status: "running",
            childThreadId: "thr_child",
            output: null,
            error: null,
            startedAt: 1,
            endedAt: null,
          },
        ],
      }),
    ]);
    expect(await slot.findByText(/Draft running/)).toBeTruthy();
  });

  it("keeps a long question from claiming the composer's width", async () => {
    const slot = banner([
      makeRun({
        status: "waiting-human",
        pendingQuestion: {
          nodeId: "grillen",
          label: "Grillen",
          question: `Should shipping costs ${"per seller ".repeat(40)}apply?`,
        },
      }),
    ]);
    const button = await slot.findByRole("button", { name: /Graph Studio: open/ });
    // The unwrapped question once pushed the submit button out of the visible
    // area until a focus change forced a re-layout.
    expect(button.textContent!.length).toBeLessThan(200);
    expect(button.className).toContain("min-w-0");
  });

  it("shows the question when the run is waiting, and opens that run on click", async () => {
    const slot = banner([
      makeRun({
        status: "waiting-human",
        pendingQuestion: {
          nodeId: "grillen",
          label: "Grillen",
          question: "Welche Datenbank?",
        },
      }),
    ]);

    fireEvent.click(await slot.findByRole("button", { name: /Graph Studio: open/ }));

    // The run id has to travel with the click: opening a bare panel is what
    // left the user guessing which window the graph belonged to.
    expect(slot.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: {
        actionId: "studio",
        title: "Graph Studio",
        params: { runId: "run_1" },
      },
    });
  });

  it("gives each live run a line and opens only the one waiting for an answer", async () => {
    localStorage.removeItem("graph-studio:run-banner-collapsed");
    const slot = banner([
      makeRun({ id: "run_a" }),
      makeRun({
        id: "run_b",
        status: "waiting-human",
        pendingQuestion: { nodeId: "grillen", label: "Grillen", question: "Welche Datenbank?" },
      }),
    ]);
    const toggles = await slot.findAllByRole("button", { name: /the graph$/ });
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
    ]);
    expect(slot.getAllByLabelText("Answer to the approval")).toHaveLength(1);
  });

  it("takes the jump from a card: opens that run and focuses its answer", async () => {
    localStorage.setItem("graph-studio:run-banner-collapsed", "1");
    const waiting = makeRun({
      status: "waiting-human",
      pendingQuestion: { nodeId: "grillen", label: "Grillen", question: "Welche Datenbank?" },
    });
    const slot = banner([waiting]);
    await slot.findByRole("button", { name: "Show the graph" });
    const card = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: "run_1" },
        source: '::graph-run{run="run_1"}',
        message: { id: "m1", threadId: "thr_1", turnId: null, projectId: "proj_1" },
        openWorkspaceFile: null,
      },
      { rpc: { getRun: () => ({ run: waiting }) }, context: { projectId: "proj_1", threadId: "thr_1" } },
    );
    fireEvent.click(await card.findByRole("button", { name: "Answer" }));
    const input = await slot.findByLabelText("Answer to the approval");
    await waitFor(() => expect(document.activeElement).toBe(input));
    // The jump answers in the banner; it does not open the studio as well.
    expect(card.navigateCalls).toEqual([]);
    localStorage.removeItem("graph-studio:run-banner-collapsed");
  });

  it("sends the card's answer to the studio when no banner shows the run", async () => {
    const waiting = makeRun({
      id: "run_elsewhere",
      status: "waiting-human",
      pendingQuestion: { nodeId: "grillen", label: "Grillen", question: "?" },
    });
    const card = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: "run_elsewhere" },
        source: '::graph-run{run="run_elsewhere"}',
        message: { id: "m1", threadId: "thr_1", turnId: null, projectId: "proj_1" },
        openWorkspaceFile: null,
      },
      { rpc: { getRun: () => ({ run: waiting }) }, context: { projectId: "proj_1", threadId: "thr_1" } },
    );
    fireEvent.click(await card.findByRole("button", { name: "Answer" }));
    expect(card.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "studio", title: "Graph Studio", params: { runId: "run_elsewhere" } },
    });
  });
});
