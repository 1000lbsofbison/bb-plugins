// bb-plugin-graph-studio — frontend entry.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  GraphStudioHeaderAction,
  GraphStudioPanel,
} from "./components/graph-studio-panel";
import { GraphStudioRunBanner } from "./components/run-banner";

/** `params` crosses the host boundary as JSON — read it, never trust it. */
function runIdFrom(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const value = (params as Record<string, unknown>).runId;
  return typeof value === "string" && value !== "" ? value : null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "studio",
    title: "Graph Studio",
    icon: "Workflow",
    path: "studio",
    component: () => <GraphStudioPanel />,
  });

  app.slots.threadPanelAction({
    id: "studio",
    title: "Graph Studio",
    icon: "Workflow",
    layout: "flush",
    run: async ({ openPanel }) => {
      openPanel({ title: "Graph Studio" });
    },
    component: ({ threadId, params }) => (
      <GraphStudioPanel threadId={threadId} initialRunId={runIdFrom(params)} />
    ),
  });

  // Above the composer of the thread that owns the run: with several windows
  // open, the panel alone does not say which conversation it belongs to.
  app.composer.customize({
    id: "graph-studio-run",
    scopes: ["thread"],
    banners: [{ id: "run", component: GraphStudioRunBanner, chrome: "bare" }],
  });

  app.slots.experimental_threadHeaderAction({
    id: "open-graph-studio",
    title: "Graph Studio",
    component: GraphStudioHeaderAction,
  });

  app.slots.commandPaletteAction({
    id: "open-graph-studio",
    title: "Graph Studio: open the panel",
    isAvailable: ({ threadId }) => threadId != null,
    run: ({ openPanel }) => {
      openPanel({ actionId: "studio", title: "Graph Studio" });
    },
  });
});
