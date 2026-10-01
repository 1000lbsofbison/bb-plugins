import { describe, expect, it } from "vitest";
import { validateCrew } from "../lib/spec";
import { memberRowId } from "../lib/store";
import { ApplyRefused, kickoffBrief } from "../lib/sync";
import type { SpawnRequest } from "../lib/thread-port";
import { PROJECT, setup, trioYaml } from "./helpers";

const byKey = <T extends { key: string }>(items: T[]) => new Map(items.map((item) => [item.key, item]));

describe("apply", () => {
  it("spawns the trio: lead first, members nested under the lead, explicit execution", async () => {
    const { service, port } = setup();
    const { crew, results } = await service.apply(PROJECT, trioYaml());
    expect(results.map((r) => [r.key, r.result])).toEqual([
      ["orch-lead", "spawned"],
      ["dev-impl", "spawned"],
      ["dev-review", "spawned"],
    ]);
    expect(crew.status).toBe("running");
    const spawns = port.calls.filter((c) => c.method === "spawn").map((c) => c.args as SpawnRequest);
    const lead = results[0]!.threadId!;
    expect(spawns[0]!.parentThreadId).toBeNull();
    expect(spawns.slice(1).map((s) => s.parentThreadId)).toEqual([lead, lead]);
    expect(spawns.map((s) => s.title)).toEqual(["orch-lead@trio", "dev-impl@trio", "dev-review@trio"]);
    expect(spawns.every((s) => s.providerId === "claude-code" && s.model === "claude-haiku-4-5-20251001")).toBe(true);
    expect(spawns[1]!.metadata).toMatchObject({ crew: "trio", member: "dev-impl", address: "dev-impl@trio", shift: 1, lead: false });
    expect(typeof spawns[1]!.metadata.opId).toBe("string");
  });

  it("environment auto: writer gets a worktree, reader reuses the lead's environment", async () => {
    const { service, port } = setup();
    const { results } = await service.apply(PROJECT, trioYaml());
    const spawns = port.calls.filter((c) => c.method === "spawn").map((c) => c.args as SpawnRequest);
    const leadEnv = port.threads.get(results[0]!.threadId!)!.environmentId;
    expect(spawns[0]!.environment).toEqual({ kind: "managed-worktree" });
    expect(spawns[1]!.environment).toEqual({ kind: "managed-worktree" });
    expect(spawns[2]!.environment).toEqual({ kind: "reuse", environmentId: leadEnv });
    const threads = results.map((r) => port.threads.get(r.threadId!)!);
    expect(threads[1]!.environmentId).not.toBe(leadEnv);
    expect(threads[2]!.environmentId).toBe(leadEnv);
  });

  it("a second apply without changes reuses every member and spawns nothing", async () => {
    const { service, port } = setup();
    await service.apply(PROJECT, trioYaml());
    const spawnsBefore = port.countCalls("spawn");
    const { results, crew } = await service.apply(PROJECT, trioYaml());
    expect(results.map((r) => r.result)).toEqual(["reused", "reused", "reused"]);
    expect(port.countCalls("spawn")).toBe(spawnsBefore);
    expect(crew.fileVersion).toBe(1);
  });

  it("refuses a crew file with errors and changes nothing", async () => {
    const { service, port, store } = setup();
    await expect(service.apply(PROJECT, trioYaml({ name: "bad.name" }))).rejects.toBeInstanceOf(ApplyRefused);
    expect(port.countCalls("spawn")).toBe(0);
    expect(store.listCrews(PROJECT)).toEqual([]);
  });

  it("full only with --confirm-full", async () => {
    const { service, port } = setup();
    const yaml = trioYaml({ permissions: "full" });
    await expect(service.apply(PROJECT, yaml)).rejects.toThrow("--confirm-full");
    const { results } = await service.apply(PROJECT, yaml, { confirmFull: true });
    expect(results.every((r) => r.result === "spawned")).toBe(true);
    expect((port.calls[0]!.args as SpawnRequest).permissions).toBe("full");
  });

  it("marks a member failed when BB resolved a different model", async () => {
    const { service, port } = setup();
    port.modelOverride.set("dev-impl@trio", "claude-sonnet-5");
    const { results, crew } = await service.apply(PROJECT, trioYaml());
    const impl = byKey(results).get("dev-impl")!;
    expect(impl.result).toBe("failed");
    expect(impl.detail).toContain("model is claude-sonnet-5");
    expect(byKey(results).get("orch-lead")!.result).toBe("spawned");
    expect(crew.status).toBe("degraded");
  });

  it("says so when BB does not report the model, instead of calling it verified", async () => {
    const { service, port } = setup();
    port.model = async () => null;
    const { results } = await service.apply(PROJECT, trioYaml());
    expect(results.map((r) => [r.result, r.detail])).toEqual(
      Array(3).fill(["spawned", "model not verifiable: BB did not report it"]),
    );
  });

  it("a failed spawn is journalled as failed, others without a lead fail with a reason", async () => {
    const { service, port, store } = setup();
    port.spawnFailures.push(new Error("provider offline"));
    const { results, crew } = await service.apply(PROJECT, trioYaml());
    expect(results.map((r) => r.result)).toEqual(["failed", "failed", "failed"]);
    expect(results[0]!.detail).toBe("provider offline");
    expect(results[1]!.detail).toContain("lead has no thread");
    const ops = store.listOps(memberRowId(crew.id, "orch-lead"));
    expect(ops.map((op) => [op.state, op.error])).toEqual([["failed", "provider offline"]]);
  });

});

describe("plan", () => {
  it("spawn for every member of a new crew, in topological order", async () => {
    const { service } = setup();
    const { items } = await service.plan(PROJECT, trioYaml());
    expect(items.map((i) => [i.key, i.action])).toEqual([
      ["orch-lead", "spawn"],
      ["dev-impl", "spawn"],
      ["dev-review", "spawn"],
    ]);
  });

  it("reuse after apply, and plan itself spawns nothing", async () => {
    const { service, port } = setup();
    await service.apply(PROJECT, trioYaml());
    const before = port.countCalls("spawn");
    const { items } = await service.plan(PROJECT, trioYaml());
    expect(items.map((i) => i.action)).toEqual(["reuse", "reuse", "reuse"]);
    expect(port.countCalls("spawn")).toBe(before);
  });

  it("unarchive when the bound thread is archived", async () => {
    const { service, port } = setup();
    const { results } = await service.apply(PROJECT, trioYaml());
    port.threads.get(results[1]!.threadId!)!.archived = true;
    const { items } = await service.plan(PROJECT, trioYaml());
    expect(byKey(items).get("dev-impl")!.action).toBe("unarchive");
    expect(byKey(items).get("orch-lead")!.action).toBe("reuse");
  });

  it("spawn when the bound thread was deleted", async () => {
    const { service, port } = setup();
    const { results } = await service.apply(PROJECT, trioYaml());
    port.threads.delete(results[2]!.threadId!);
    const item = byKey((await service.plan(PROJECT, trioYaml())).items).get("dev-review")!;
    expect(item.action).toBe("spawn");
    expect(item.reasons[0]).toContain("is gone");
  });

  it("update when title, parent or model drift; apply patches them", async () => {
    const { service, port } = setup();
    const { results } = await service.apply(PROJECT, trioYaml());
    const impl = port.threads.get(results[1]!.threadId!)!;
    impl.title = "renamed";
    impl.parentThreadId = null;
    impl.model = "other-model";
    const item = byKey((await service.plan(PROJECT, trioYaml())).items).get("dev-impl")!;
    expect(item.action).toBe("update");
    expect(item.reasons).toHaveLength(3);
    const second = await service.apply(PROJECT, trioYaml());
    expect(byKey(second.results).get("dev-impl")!.result).toBe("updated");
    expect(impl.title).toBe("dev-impl@trio");
    expect(impl.parentThreadId).toBe(results[0]!.threadId);
    expect(impl.model).toBe("claude-haiku-4-5-20251001");
  });

  it("a model change in the crew file is an update, not a respawn", async () => {
    const { service, port } = setup();
    await service.apply(PROJECT, trioYaml());
    const spawns = port.countCalls("spawn");
    const changed = trioYaml({ model: "claude-sonnet-5" });
    expect((await service.plan(PROJECT, changed)).items.map((i) => i.action)).toEqual(["update", "update", "update"]);
    const { results, crew } = await service.apply(PROJECT, changed);
    expect(results.map((r) => r.result)).toEqual(["updated", "updated", "updated"]);
    expect(port.countCalls("spawn")).toBe(spawns);
    expect(crew.fileVersion).toBe(2);
  });

  it("a provider change fails honestly and asks for --fresh", async () => {
    const { service } = setup();
    await service.apply(PROJECT, trioYaml());
    const { results } = await service.apply(PROJECT, trioYaml({ provider: "codex" }));
    expect(results.every((r) => r.result === "failed" && r.detail!.includes("--fresh"))).toBe(true);
  });

  it("remove for a member dropped from the file; apply archives, never deletes", async () => {
    const { service, port } = setup();
    const first = await service.apply(PROJECT, trioYaml());
    const smaller = trioYaml({
      groups: [
        { id: "orch", members: [{ id: "lead", lead: true }] },
        { id: "dev", members: [{ id: "impl" }] },
      ],
      links: [],
    });
    const { items } = await service.plan(PROJECT, smaller);
    expect(byKey(items).get("dev-review")!.action).toBe("remove");
    const { results } = await service.apply(PROJECT, smaller);
    expect(byKey(results).get("dev-review")!.result).toBe("removed");
    const review = port.threads.get(first.results[2]!.threadId!)!;
    expect(review.archived).toBe(true);
    expect((await service.plan(PROJECT, smaller)).items.map((i) => i.action)).toEqual(["reuse", "reuse"]);
  });

  it("--fresh spawns a new shift and archives the old thread", async () => {
    const { service, port } = setup();
    const first = await service.apply(PROJECT, trioYaml());
    const { items } = await service.plan(PROJECT, trioYaml(), { fresh: ["dev-impl"] });
    expect(byKey(items).get("dev-impl")!.action).toBe("spawn");
    const { results } = await service.apply(PROJECT, trioYaml(), { fresh: ["dev-impl"] });
    const impl = byKey(results).get("dev-impl")!;
    expect(impl.result).toBe("spawned");
    expect(impl.shift).toBe(2);
    expect(impl.threadId).not.toBe(first.results[1]!.threadId);
    expect(port.threads.get(first.results[1]!.threadId!)!.archived).toBe(true);
  });
});

describe("crash recovery", () => {
  it("intent written, thread exists with opId, no done → next apply binds it, no duplicate", async () => {
    const { service, port, store } = setup();
    // Simulate: apply got as far as journal step 1 and BB created the thread,
    // then the process died before step 3.
    const { crew } = store.saveCrewFile(PROJECT, "trio", trioYaml());
    const leadRow = store.upsertMember(crew.id, {
      groupId: "orch",
      memberId: "lead",
      address: "orch-lead@trio",
      lead: true,
      config: {},
    });
    store.insertOp({ opId: "op_crash", memberId: leadRow.id, kind: "spawn" });
    const orphan = await port.spawn({
      projectId: PROJECT,
      prompt: "kickoff",
      title: "orch-lead@trio",
      providerId: "claude-code",
      model: "claude-haiku-4-5-20251001",
      permissions: "accept-edits",
      parentThreadId: null,
      environment: { kind: "managed-worktree" },
      metadata: { crew: "trio", crewId: crew.id, member: "orch-lead", address: "orch-lead@trio", shift: 1, opId: "op_crash", lead: true },
    });
    expect((await service.plan(PROJECT, trioYaml())).items[0]!.reasons.join(" ")).toContain("unfinished spawn");
    const spawnsBefore = port.countCalls("spawn");

    const { results } = await service.apply(PROJECT, trioYaml());
    const lead = results[0]!;
    expect(lead.result).toBe("spawned");
    expect(lead.threadId).toBe(orphan.id);
    expect(lead.detail).toContain("op_crash");
    // Only impl and review were spawned; the lead was bound, not duplicated.
    expect(port.countCalls("spawn") - spawnsBefore).toBe(2);
    const leadThreads = [...port.threads.values()].filter((t) => t.title === "orch-lead@trio");
    expect(leadThreads).toHaveLength(1);
    expect(store.listOps(leadRow.id).map((op) => [op.opId, op.state, op.threadId])).toContainEqual(["op_crash", "done", orphan.id]);
  });

  it("negative: intent without a thread → intent closed as failed, a new thread is spawned", async () => {
    const { service, port, store } = setup();
    const { crew } = store.saveCrewFile(PROJECT, "trio", trioYaml());
    const leadRow = store.upsertMember(crew.id, { groupId: "orch", memberId: "lead", address: "orch-lead@trio", lead: true, config: {} });
    store.insertOp({ opId: "op_lost", memberId: leadRow.id, kind: "spawn" });
    const { results } = await service.apply(PROJECT, trioYaml());
    expect(results[0]!.result).toBe("spawned");
    expect(results[0]!.detail).toBeNull();
    expect(port.countCalls("spawn")).toBe(3);
    expect(store.listOps(leadRow.id).find((op) => op.opId === "op_lost")!.state).toBe("failed");
  });

  it("negative: a foreign thread with another opId is not bound", async () => {
    const { service, port, store } = setup();
    const { crew } = store.saveCrewFile(PROJECT, "trio", trioYaml());
    const leadRow = store.upsertMember(crew.id, { groupId: "orch", memberId: "lead", address: "orch-lead@trio", lead: true, config: {} });
    store.insertOp({ opId: "op_mine", memberId: leadRow.id, kind: "spawn" });
    const foreign = await port.spawn({
      projectId: PROJECT,
      prompt: "x",
      title: "other",
      providerId: "claude-code",
      model: "m",
      permissions: "ask",
      parentThreadId: null,
      environment: { kind: "project-default" },
      metadata: { crew: "x", crewId: "x", member: "x", address: "x", shift: 1, opId: "op_other", lead: true },
    });
    const { results } = await service.apply(PROJECT, trioYaml());
    expect(results[0]!.threadId).not.toBe(foreign.id);
  });
});

describe("stop", () => {
  it("stop stops the turns, keeps threads visible, crew stopped", async () => {
    const { service, port } = setup();
    const { crew } = await service.apply(PROJECT, trioYaml());
    const results = await service.stop(crew);
    expect(results.every((r) => r.stopped && !r.archived)).toBe(true);
    expect(port.countCalls("stop")).toBe(3);
    expect(port.countCalls("archive")).toBe(0);
    expect(service.findCrew(PROJECT, "trio")!.status).toBe("stopped");
  });

  it("stop --archive archives; the next apply reports unarchived and running", async () => {
    const { service, port } = setup();
    const { crew } = await service.apply(PROJECT, trioYaml());
    const results = await service.stop(crew, { archive: true });
    expect(results.every((r) => r.archived)).toBe(true);
    expect([...port.threads.values()].every((t) => t.archived)).toBe(true);
    const spawns = port.countCalls("spawn");
    const again = await service.apply(PROJECT, trioYaml());
    expect(again.results.map((r) => r.result)).toEqual(["unarchived", "unarchived", "unarchived"]);
    expect(port.countCalls("spawn")).toBe(spawns);
    expect(again.crew.status).toBe("running");
    expect([...port.threads.values()].some((t) => t.archived)).toBe(false);
  });

  it("stops children before the lead", async () => {
    const { service, port } = setup();
    const { crew, results } = await service.apply(PROJECT, trioYaml());
    await service.stop(crew);
    const order = port.calls.filter((c) => c.method === "stop").map((c) => c.args);
    expect(order.at(-1)).toBe(results[0]!.threadId);
  });
});

describe("members view", () => {
  it("reports thread present/archived/missing with shift", async () => {
    const { service, port } = setup();
    const { crew, results } = await service.apply(PROJECT, trioYaml());
    port.threads.get(results[1]!.threadId!)!.archived = true;
    port.threads.delete(results[2]!.threadId!);
    const views = byKey(await service.members(crew));
    expect(views.get("orch-lead")!.thread).toBe("present");
    expect(views.get("orch-lead")!.shift).toBe(1);
    expect(views.get("dev-impl")!.thread).toBe("archived");
    expect(views.get("dev-review")!.thread).toBe("missing");
    expect(views.get("orch-lead")!.actualModel).toBe("claude-haiku-4-5-20251001");
    expect(views.get("dev-review")!.actualModel).toBeNull();
  });
});

describe("kickoff brief", () => {
  it("names address, role, peers and the first task", () => {
    const validation = validateCrew(trioYaml());
    const brief = kickoffBrief(validation.spec!, validation.members[1]!, validation.members);
    expect(brief).toContain("You are dev-impl@trio");
    expect(brief).toContain("Role: Builds.");
    expect(brief).toContain("- orch-lead (orch-lead@trio) (lead)");
    expect(brief).toContain("First task: Reply with OK and wait for instructions.");
  });
  it("carries the address and the reply rules; the member itself is not a peer", () => {
    const validation = validateCrew(trioYaml());
    const brief = kickoffBrief(validation.spec!, validation.members[1]!, validation.members);
    expect(brief).toContain("[crew] Kickoff brief for dev-impl@trio");
    expect(brief).toContain("Your address is dev-impl@trio");
    expect(brief).toContain("crew_send(to: <sender from the header>, reply_to: <msg id>");
    expect(brief).toContain('crew_send(to: "human", kind: "info"');
    expect(brief).toContain('crew_send(to: "human", kind: "question"');
    expect(brief).toContain("A chain stops at step 6");
    expect(brief).not.toContain("- dev-impl (dev-impl@trio)");
  });
  it("links mode and crossCrew none show up in the rules only when set", () => {
    const open = validateCrew(trioYaml());
    const openBrief = kickoffBrief(open.spec!, open.members[1]!, open.members);
    expect(openBrief).not.toContain("messaging: links");
    const strict = validateCrew(trioYaml({ messaging: "links", crossCrew: "none", maxSteps: 4 }));
    const strictBrief = kickoffBrief(strict.spec!, strict.members[1]!, strict.members);
    expect(strictBrief).toContain("messaging: links");
    expect(strictBrief).toContain("does not message other crews");
    expect(strictBrief).toContain("A chain stops at step 4");
  });
  it("defaults to waiting for the lead", () => {
    const validation = validateCrew(trioYaml({ kickoff: undefined }));
    expect(kickoffBrief(validation.spec!, validation.members[0]!, validation.members)).toContain("Wait for instructions from your lead.");
  });
});
