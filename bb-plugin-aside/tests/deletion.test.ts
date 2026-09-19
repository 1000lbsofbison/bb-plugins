import { describe, expect, it, vi } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { collectFamilies, planDeletion } from "@/lib/deletion";

function thread(
  id: string,
  parentThreadId: string | null = null,
): PluginSidebarThread {
  return { id, parentThreadId } as PluginSidebarThread;
}

describe("planDeletion", () => {
  it("counts the children that go down with a picked root", () => {
    const threads = [thread("a"), thread("a1", "a"), thread("a2", "a")];
    const plan = planDeletion(threads, new Set(["a"]));
    expect(plan.chosen).toEqual(["a"]);
    expect(plan.alsoDeleted.sort()).toEqual(["a1", "a2"]);
  });

  it("reaches grandchildren, not just the first generation", () => {
    const threads = [thread("a"), thread("a1", "a"), thread("a1x", "a1")];
    expect(planDeletion(threads, new Set(["a"])).alsoDeleted.sort()).toEqual([
      "a1",
      "a1x",
    ]);
  });

  // The negative case that makes the confirmation honest: a thread must never
  // be counted twice, or "3 threads and 2 agents" would announce five deletions
  // where four happen.
  it("does NOT list a picked child a second time under its picked parent", () => {
    const threads = [thread("a"), thread("a1", "a")];
    const plan = planDeletion(threads, new Set(["a", "a1"]));
    expect(plan.chosen).toEqual(["a"]);
    expect(plan.alsoDeleted).toEqual([]);
  });

  it("does NOT pull in a sibling that was never picked", () => {
    const threads = [thread("a"), thread("b"), thread("b1", "b")];
    const plan = planDeletion(threads, new Set(["a"]));
    expect(plan.chosen).toEqual(["a"]);
    expect(plan.alsoDeleted).toEqual([]);
  });

  it("drops a selected id the thread list no longer knows", () => {
    const plan = planDeletion([thread("a")], new Set(["a", "gone"]));
    expect(plan.chosen).toEqual(["a"]);
  });

  it("survives a parent cycle instead of hanging", () => {
    const threads = [thread("a", "b"), thread("b", "a")];
    expect(planDeletion(threads, new Set(["a"])).chosen).toEqual(["a"]);
  });

  it("returns nothing at all for an empty selection", () => {
    const plan = planDeletion([thread("a"), thread("a1", "a")], new Set());
    expect(plan.chosen).toEqual([]);
    expect(plan.alsoDeleted).toEqual([]);
  });
});

describe("collectFamilies", () => {
  const tree: Record<string, string[]> = {
    a: ["a1", "a2"],
    a1: ["a1x"],
    a2: [],
    a1x: [],
    b: [],
  };
  const listChildren = (id: string) => Promise.resolve(tree[id] ?? []);

  it("addresses every descendant, children before their parent", async () => {
    const order = await collectFamilies(["a"], listChildren);
    expect(order).toEqual(["a1x", "a1", "a2", "a"]);
  });

  it("walks several roots in one go", async () => {
    expect(await collectFamilies(["b", "a2"], listChildren)).toEqual(["b", "a2"]);
  });

  // A parent deleted before its child would orphan it — that is the host bug
  // this feature works around, and repeating it here would be absurd.
  it("never puts a parent before one of its children", async () => {
    const order = await collectFamilies(["a"], listChildren);
    expect(order.indexOf("a")).toBeGreaterThan(order.indexOf("a1"));
    expect(order.indexOf("a1")).toBeGreaterThan(order.indexOf("a1x"));
  });

  it("asks for every thread exactly once, even when two roots overlap", async () => {
    const spy = vi.fn(listChildren);
    const order = await collectFamilies(["a", "a1"], spy);
    expect(order.filter((id) => id === "a1")).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("terminates on a cycle instead of recursing forever", async () => {
    const cyclic = (id: string) =>
      Promise.resolve(id === "x" ? ["y"] : id === "y" ? ["x"] : []);
    expect(await collectFamilies(["x"], cyclic)).toEqual(["y", "x"]);
  });
});
