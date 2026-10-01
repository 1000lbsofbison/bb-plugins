// @vitest-environment jsdom
//
// BBP-17: one glyph everywhere — the sidebar's branding icon — and a button
// that says "Graph Studio", not "Graph".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import graphStudio from "../server";
import { GRAPH_STUDIO_ICON } from "../lib/icon";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app"));
});
afterEach(cleanup);

function headerButton(isCompactViewport: boolean) {
  return renderSlot(
    app.threadHeaderActions[0]! as never,
    { threadId: "thr_1", projectId: "proj_1", isCompactViewport } as never,
    { context: { projectId: "proj_1", threadId: "thr_1" } },
  );
}

describe("the Graph Studio icon", () => {
  it("is registered once under its own name", () => {
    expect(app.icons.map((entry) => entry.name)).toEqual([GRAPH_STUDIO_ICON]);
  });

  it("is the icon of the nav panel and the thread panel action, not Workflow", () => {
    expect(app.navPanels.map((entry) => entry.icon)).toEqual([GRAPH_STUDIO_ICON]);
    expect(app.threadPanelActions.map((entry) => entry.icon)).toEqual([GRAPH_STUDIO_ICON]);
    expect([...app.navPanels, ...app.threadPanelActions].some((entry) => entry.icon === "Workflow")).toBe(false);
  });

  it("draws the same paths as the branding icon assets/icon.svg", () => {
    const branding = readFileSync(join(__dirname, "..", "assets", "icon.svg"), "utf8");
    const slot = headerButton(false);
    const svg = slot.container.querySelector(`svg[data-icon="${GRAPH_STUDIO_ICON}"]`);
    expect(svg).not.toBeNull();
    const shapes = [...svg!.querySelectorAll("circle, path")].map((node) =>
      node.tagName === "circle"
        ? `circle ${node.getAttribute("cx")} ${node.getAttribute("cy")} ${node.getAttribute("r")}`
        : `path ${node.getAttribute("d")}`,
    );
    const expected = [...branding.matchAll(/<(circle|path)\s([^>]*)\/>/g)].map(([, tag, attrs]) => {
      const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs!)?.[1];
      return tag === "circle" ? `circle ${attr("cx")} ${attr("cy")} ${attr("r")}` : `path ${attr("d")}`;
    });
    expect(expected.length).toBeGreaterThan(0);
    expect(shapes).toEqual(expected);
  });

  it("is the icon of the # mention rows", async () => {
    const host = createFakePluginHost({ pluginId: "graph-studio" });
    graphStudio(host.bb);
    const provider = host.harness.inspection.registrations.mentionProviders.find((entry) => entry.id === "graphs")!;
    const items = await provider.search({ query: "" } as never);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.icon === GRAPH_STUDIO_ICON)).toBe(true);
    await host.harness.lifecycle.dispose();
  });
});

describe("the thread panel button", () => {
  it('says "Graph Studio" and shows the glyph', () => {
    const slot = headerButton(false);
    const button = slot.getByRole("button", { name: "Open Graph Studio" });
    expect(button.textContent).toBe("Graph Studio");
    expect(button.querySelector(`svg[data-icon="${GRAPH_STUDIO_ICON}"]`)).not.toBeNull();
  });

  it('no longer says just "Graph" (negative), and stays icon-only when compact', () => {
    expect(headerButton(false).queryByText(/^Graph$/)).toBeNull();
    cleanup();
    const compact = headerButton(true).getByRole("button", { name: "Open Graph Studio" });
    expect(compact.textContent).toBe("");
    expect(compact.querySelector(`svg[data-icon="${GRAPH_STUDIO_ICON}"]`)).not.toBeNull();
  });
});
