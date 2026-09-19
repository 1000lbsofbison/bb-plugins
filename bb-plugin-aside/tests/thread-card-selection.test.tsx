// @vitest-environment jsdom
//
// The render condition of selection mode, checked in both directions. A test
// that only asserts "no checkbox while off" would stay green if the checkbox
// never appeared at all — which in a sidebar is silence, not an error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useSidebarThreadActions: () => ({
    open: vi.fn(),
    setPinned: vi.fn(),
    setRead: vi.fn(),
    archive: vi.fn(),
    requestDelete: vi.fn(),
    rename: vi.fn(),
  }),
  experimental_useSidebarThreadSplit: () => ({ splitProps: {} }),
  experimental_ProviderIcon: () => null,
}));

const { ThreadCard } = await import("@/components/sidenav/thread-card");
import type { CardCallbacks } from "@/components/sidenav/thread-card";
import type { Family } from "@/lib/tree";

afterEach(cleanup);

function thread(id: string, title: string): PluginSidebarThread {
  return {
    id,
    title,
    titleFallback: null,
    parentThreadId: null,
    projectId: "p",
    sectionId: null,
    providerId: "claude",
    isPinned: false,
    isUnread: false,
    isArchived: false,
    hasPendingInteraction: false,
    indicator: null,
    createdAt: 0,
    updatedAt: 0,
    latestAttentionAt: 0,
    environment: null,
    host: null,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
  } as unknown as PluginSidebarThread;
}

const family: Family = {
  root: thread("a", "Root"),
  children: [thread("a1", "Agent")],
};

let callbacks: CardCallbacks;

beforeEach(() => {
  callbacks = {
    onOpen: vi.fn(),
    onToggleChildren: vi.fn(),
    onRename: vi.fn(),
    onSetSection: vi.fn(),
    onCreateSection: vi.fn(),
    onNest: vi.fn(),
    onReorder: vi.fn(),
    onDropRejected: vi.fn(),
  };
});

function card(selection: Parameters<typeof ThreadCard>[0]["selection"]) {
  return (
    <ThreadCard
      family={family}
      providers={new Map()}
      sections={[]}
      activeThreadId={null}
      childrenOpen
      compact={false}
      now={0}
      renaming={false}
      selection={selection}
      onStartRename={vi.fn()}
      onCancelRename={vi.fn()}
      callbacks={callbacks}
    />
  );
}

describe("thread card in selection mode", () => {
  it("carries NO checkbox while the mode is off", () => {
    render(card(null));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("carries a checkbox on the root and on every agent while it is on", () => {
    render(card({ selected: new Set(), onToggle: vi.fn() }));
    expect(screen.getByRole("checkbox", { name: "Select Root" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Agent" })).toBeTruthy();
  });

  it("opens the thread on a click while the mode is off", () => {
    render(card(null));
    fireEvent.click(screen.getByText("Root"));
    expect(callbacks.onOpen).toHaveBeenCalledWith("a", false);
  });

  // Opening a thread you meant to tick would scroll the list away under the
  // hand that is picking.
  it("selects instead of opening while the mode is on", () => {
    const onToggle = vi.fn();
    render(card({ selected: new Set(), onToggle }));
    fireEvent.click(screen.getByText("Root"));
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledWith("a", true);
  });

  it("unticks a row that is already selected", () => {
    const onToggle = vi.fn();
    render(card({ selected: new Set(["a"]), onToggle }));
    fireEvent.click(screen.getByText("Root"));
    expect(onToggle).toHaveBeenCalledWith("a", false);
  });

  it("selects an agent on its own, without its root", () => {
    const onToggle = vi.fn();
    render(card({ selected: new Set(), onToggle }));
    fireEvent.click(screen.getByText("Agent"));
    expect(onToggle).toHaveBeenCalledWith("a1", true);
  });

  it("shows the box as checked for a selected thread", () => {
    render(card({ selected: new Set(["a"]), onToggle: vi.fn() }));
    expect(
      screen.getByRole("checkbox", { name: "Select Root" }).getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByRole("checkbox", { name: "Select Agent" }).getAttribute("data-state"),
    ).toBe("unchecked");
  });

  it("stops dragging while the mode is on", () => {
    const { container } = render(card({ selected: new Set(), onToggle: vi.fn() }));
    expect(container.querySelector("[data-aside-card]")?.getAttribute("draggable")).toBe(
      "false",
    );
  });
});
