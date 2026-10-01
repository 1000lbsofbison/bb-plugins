import { describe, expect, it } from "vitest";
import { addMemberToFile, CrewFileEditError, removeMemberFromFile } from "../lib/crewfile";
import { AddressError } from "../lib/delivery";
import { openLayout } from "../lib/layout";
import { PROJECT, running, setup, trioYaml } from "./helpers";

async function trio() {
  const env = setup();
  const crew = await running(env.service, env.port);
  const human = { kind: "human" as const };
  const thread = (id: string) => env.port.threads.get(id)!;
  const inboxHas = (threadId: string, marker: string) => thread(threadId).inbox.filter((entry) => entry.text.includes(marker)).length;
  return { ...env, ...crew, human, thread, inboxHas };
}

describe("snapshot and restore", () => {
  it("snapshot → archive all → restore: same bindings, same open work items, held messages delivered", async () => {
    const t = await trio();
    const { service, store, crew, threads, members } = t;
    const open = service.queue.create(crew, t.human, { title: "Write the parser", owner: "dev-impl" });
    const claimed = service.queue.claim(crew, t.human, service.queue.create(crew, t.human, { title: "Review", owner: "dev-review" }).id, "dev-review");
    // A message that waits for an open question: part of the delivery queue.
    t.thread(threads["dev-impl"]!).interactions.push({ id: "int_1", kind: "question", title: "Which branch?" });
    const [held] = await service.send({ projectId: PROJECT, from: t.human, to: "dev-impl@trio", body: "Use main." });
    expect(held!.status).toBe("on_hold");

    const { id, data } = service.lifecycle.snapshot(crew, "before archive");
    expect(data.bindings.map((b) => [b.key, b.threadId, b.shift])).toEqual([
      ["orch-lead", threads["orch-lead"], 1],
      ["dev-impl", threads["dev-impl"], 1],
      ["dev-review", threads["dev-review"], 1],
    ]);
    expect(data.work.map((item) => item.id).sort()).toEqual([open.id, claimed.id].sort());
    expect(data.messages.map((m) => m.id)).toEqual([held!.id]);

    await service.stop(store.getCrew(crew.id)!, { archive: true });
    expect([...t.port.threads.values()].every((entry) => entry.archived)).toBe(true);
    // After the snapshot someone closes an item: restore puts it back.
    service.queue.done(crew, t.human, open.id, "closed by mistake");

    t.thread(threads["dev-impl"]!).interactions.length = 0;
    const report = await service.lifecycle.restore(id);
    const bindings = Object.fromEntries(Object.values(members).map((m) => [m.key, store.currentBinding(m.id)!.threadId]));
    expect(bindings).toEqual(threads);
    expect(report.bindings.every((entry) => entry.change === "same")).toBe(true);
    expect(report.outcome.results.map((r) => r.result)).toEqual(["unarchived", "unarchived", "unarchived"]);
    expect(report.work.restored).toEqual([open.id]);
    const after = service.queue.list(store.getCrew(crew.id)!);
    expect(after.map((item) => [item.id, item.state]).sort()).toEqual([[open.id, "open"], [claimed.id, "claimed"]].sort());
    expect(store.getMessage(held!.id)!.status).toBe("delivered");
    expect(t.inboxHas(threads["dev-impl"]!, `msg ${held!.id}`)).toBe(1);
  });

  it("a message delivered after the snapshot is not sent again; a later reset is rolled back to the snapshot's thread", async () => {
    const t = await trio();
    const { service, store, crew, threads, members } = t;
    t.thread(threads["dev-impl"]!).interactions.push({ id: "int_1", kind: "question", title: "?" });
    const [held] = await service.send({ projectId: PROJECT, from: t.human, to: "dev-impl@trio", body: "Later." });
    const { id } = service.lifecycle.snapshot(crew);
    t.thread(threads["dev-impl"]!).interactions.length = 0;
    await service.delivery.drain();
    expect(t.inboxHas(threads["dev-impl"]!, `msg ${held!.id}`)).toBe(1);

    const reset = await service.lifecycle.reset(crew, "dev-impl", "new");
    expect(reset.threadId).not.toBe(threads["dev-impl"]);
    const report = await service.lifecycle.restore(id);
    expect(report.messages.alreadyDelivered).toEqual([held!.id]);
    expect(t.inboxHas(threads["dev-impl"]!, `msg ${held!.id}`)).toBe(1);
    expect(report.bindings.find((entry) => entry.key === "dev-impl")!.change).toBe("rebound");
    expect(store.currentBinding(members["dev-impl"]!.id)).toMatchObject({ threadId: threads["dev-impl"], shift: 1 });
    expect(t.thread(threads["dev-impl"]!).archived).toBe(false);
    expect(t.thread(reset.threadId!).metadata.retired).toBe(true);
  });

  it("negative: an unknown snapshot is refused", async () => {
    const t = await trio();
    await expect(t.service.lifecycle.restore("snap_nope")).rejects.toThrow(AddressError);
  });
});

describe("reset", () => {
  it("clear: same thread, shift + 1, context cleared, kickoff brief sent, metadata follows", async () => {
    const t = await trio();
    const { service, store, crew, threads, members } = t;
    const result = await service.lifecycle.reset(crew, "dev-impl", "clear");
    expect(result).toMatchObject({ threadId: threads["dev-impl"], shift: 2 });
    expect(t.port.countCalls("clearContext")).toBe(1);
    expect(t.port.countCalls("spawn")).toBe(3);
    expect(store.listBindings(members["dev-impl"]!.id).map((b) => [b.shift, b.threadId, b.retiredAt === null])).toEqual([
      [1, threads["dev-impl"], false],
      [2, threads["dev-impl"], true],
    ]);
    expect(t.thread(threads["dev-impl"]!).metadata.shift).toBe(2);
    expect(t.thread(threads["dev-impl"]!).inbox.at(-1)!.text).toContain("This is shift 2: your context was cleared");
    expect(store.memberByThread(threads["dev-impl"]!)?.key).toBe("dev-impl");
  });

  it("new: a new thread for shift 2, the old one archived with retired: true, still nested under the lead", async () => {
    const t = await trio();
    const { service, store, crew, threads, members } = t;
    const result = await service.lifecycle.reset(crew, "dev-impl", "new");
    expect(result.result).toBe("spawned");
    expect(result.shift).toBe(2);
    expect(result.threadId).not.toBe(threads["dev-impl"]);
    expect(t.thread(threads["dev-impl"]!)).toMatchObject({ archived: true });
    expect(t.thread(threads["dev-impl"]!).metadata).toMatchObject({ retired: true, member: "dev-impl" });
    expect(t.thread(result.threadId!).parentThreadId).toBe(threads["orch-lead"]);
    expect(store.currentBinding(members["dev-impl"]!.id)!.threadId).toBe(result.threadId);
    expect(t.port.countCalls("clearContext")).toBe(0);
  });

  it("a lead reset with a new thread moves the members under the new lead thread", async () => {
    const t = await trio();
    const result = await t.service.lifecycle.reset(t.crew, "orch-lead", "new");
    expect(t.thread(t.threads["dev-impl"]!).parentThreadId).toBe(result.threadId);
    expect(t.thread(t.threads["dev-review"]!).parentThreadId).toBe(result.threadId);
  });

  it("negative: an unknown member and a member in handover are refused", async () => {
    const t = await trio();
    await expect(t.service.lifecycle.reset(t.crew, "dev-ghost", "clear")).rejects.toThrow(/No member "dev-ghost"/);
    await t.service.lifecycle.handover(t.crew, "dev-impl");
    await expect(t.service.lifecycle.reset(t.crew, "dev-impl", "clear")).rejects.toThrow(/in a handover/);
  });
});

describe("handover", () => {
  it("shift + 1: held messages reach the new thread exactly once, the brief arrives as a work item", async () => {
    const t = await trio();
    const { service, store, crew, threads, members } = t;
    const old = threads["dev-impl"]!;
    const { handover } = await service.lifecycle.handover(crew, "dev-impl");
    expect(handover.state).toBe("writing");
    expect(t.thread(old).inbox.at(-1)!.text).toContain("crew_handover_note");

    const [held] = await service.send({ projectId: PROJECT, from: t.human, to: "dev-impl@trio", body: "Status?" });
    expect(held).toMatchObject({ status: "on_hold", hold: "handover" });
    const fromLead = await service.send({ projectId: PROJECT, from: t.self("orch-lead"), to: "dev-impl", body: "Next task." });
    expect(fromLead[0]!.status).toBe("on_hold");

    service.lifecycle.noteBrief(members["dev-impl"]!, "Parser half done on bb/impl; tests red in lexer.");
    // Negative: the old thread is still running its turn — nothing happens yet.
    t.thread(old).status = "active";
    expect(await service.lifecycle.tick()).toBe(0);
    expect(store.getMessage(held!.id)!.status).toBe("on_hold");

    t.thread(old).status = "idle";
    expect(await service.lifecycle.tick()).toBe(1);
    const binding = store.currentBinding(members["dev-impl"]!.id)!;
    expect(binding.shift).toBe(2);
    expect(binding.threadId).not.toBe(old);
    const done = store.getHandover(handover.id)!;
    expect(done).toMatchObject({ state: "done", newThread: binding.threadId });
    const item = store.getWork(done.itemId!)!;
    expect(item).toMatchObject({ ownerMember: members["dev-impl"]!.id, body: "Parser half done on bb/impl; tests red in lexer.", state: "open" });
    expect(t.thread(binding.threadId).request!.prompt).toContain(`work item ${item.id}`);
    expect(t.thread(old)).toMatchObject({ archived: true });
    expect(t.thread(old).metadata.retired).toBe(true);

    for (const row of [held!, fromLead[0]!]) {
      expect(store.getMessage(row.id)!.status).toMatch(/delivered|queued/);
      expect(t.inboxHas(binding.threadId, `msg ${row.id}`)).toBe(1);
      expect(t.inboxHas(old, `msg ${row.id}`)).toBe(0);
    }
    // A second tick and another drain change nothing: exactly once.
    expect(await service.lifecycle.tick()).toBe(0);
    await service.delivery.drain();
    expect(t.inboxHas(binding.threadId, `msg ${held!.id}`)).toBe(1);
    expect(t.port.countCalls("spawn")).toBe(4);
  });

  it("a brief from the human completes at once; a lead handover re-parents the members", async () => {
    const t = await trio();
    const { handover, result } = await t.service.lifecycle.handover(t.crew, "orch-lead", { brief: "All quiet." });
    expect(handover.state).toBe("done");
    expect(result!.shift).toBe(2);
    expect(t.thread(t.threads["dev-impl"]!).parentThreadId).toBe(result!.threadId);
  });

  it("crew_handover_note without a running handover starts one itself (self-initiated)", async () => {
    const t = await trio();
    const row = t.service.lifecycle.noteBrief(t.members["dev-review"]!, "Nothing open.");
    expect(row).toMatchObject({ state: "noted", oldShift: 1, brief: "Nothing open." });
  });

  it("negative: an empty brief is refused; a cancelled handover releases the held messages to the old thread", async () => {
    const t = await trio();
    expect(() => t.service.lifecycle.noteBrief(t.members["dev-impl"]!, "  ")).toThrow(/empty/);
    await t.service.lifecycle.handover(t.crew, "dev-impl");
    const [held] = await t.service.send({ projectId: PROJECT, from: t.human, to: "dev-impl@trio", body: "Hi" });
    expect(held!.status).toBe("on_hold");
    t.service.lifecycle.cancelHandover(t.crew, "dev-impl");
    await t.service.delivery.drain();
    expect(t.inboxHas(t.threads["dev-impl"]!, `msg ${held!.id}`)).toBe(1);
    expect(t.store.currentBinding(t.members["dev-impl"]!.id)!.shift).toBe(1);
  });

  it("negative: messages to other members are not held by someone else's handover", async () => {
    const t = await trio();
    await t.service.lifecycle.handover(t.crew, "dev-impl");
    const [row] = await t.service.send({ projectId: PROJECT, from: t.human, to: "dev-review@trio", body: "Hi" });
    expect(row!.status).toBe("delivered");
  });
});

describe("attach and detach", () => {
  it("binds an existing thread without spawning; the kickoff brief comes as a crew message", async () => {
    const t = await trio();
    const { service, store, crew, threads, members } = t;
    const foreign = t.port.addForeign({ id: "thr_mine", projectId: PROJECT, title: "my notes", status: "idle" });
    expect((await service.lifecycle.candidates(PROJECT)).map((th) => th.id)).toEqual(["thr_mine"]);
    await service.lifecycle.detach(crew, "dev-review");
    expect(t.thread(threads["dev-review"]!).metadata.retired).toBe(true);
    expect((await service.lifecycle.candidates(PROJECT)).map((th) => th.id).sort()).toEqual(["thr_mine", threads["dev-review"]!].sort());

    const spawnsBefore = t.port.countCalls("spawn");
    const sendsBefore = t.port.countCalls("send");
    const result = await service.lifecycle.attach(crew, "thr_mine", "dev-review@trio");
    // attach itself spawns nothing and sends nothing; the kickoff is a message row
    expect(t.port.countCalls("spawn")).toBe(spawnsBefore);
    expect(t.port.countCalls("send")).toBe(sendsBefore);
    expect(result).toMatchObject({ threadId: "thr_mine", shift: 2 });
    expect(result.kickoff).toMatchObject({ status: "pending", fromAddress: "system", toAddress: "dev-review@trio", kind: "message" });
    expect(foreign).toMatchObject({ title: "dev-review@trio", parentThreadId: threads["orch-lead"] });
    expect(foreign.metadata).toMatchObject({ crew: "trio", member: "dev-review", address: "dev-review@trio", shift: 2, lead: false, retired: false });
    expect(store.memberByThread("thr_mine")?.id).toBe(members["dev-review"]!.id);

    await service.delivery.drain();
    expect(store.getMessage(result.kickoff!.id)!.status).toBe("delivered");
    expect(foreign.inbox).toHaveLength(1);
    expect(foreign.inbox[0]!.text).toContain("[crew] Kickoff brief for dev-review@trio");
    expect(foreign.inbox[0]!.text).toContain("From: system");
  });

  it("negative: refuses a thread of another project, one already bound, an archived one, and a member that still has a thread", async () => {
    const t = await trio();
    const { service, crew, threads } = t;
    t.port.addForeign({ id: "thr_other", projectId: "proj_other" });
    await expect(service.lifecycle.attach(crew, "thr_other", "dev-review")).rejects.toThrow(/belongs to project proj_other/);
    await expect(service.lifecycle.attach(crew, threads["dev-impl"]!, "dev-review")).rejects.toThrow(/already bound to dev-impl@trio/);
    t.port.addForeign({ id: "thr_arch", projectId: PROJECT, archived: true });
    await expect(service.lifecycle.attach(crew, "thr_arch", "dev-review")).rejects.toThrow(/archived/);
    t.port.addForeign({ id: "thr_free", projectId: PROJECT });
    await expect(service.lifecycle.attach(crew, "thr_free", "dev-review")).rejects.toThrow(/--replace/);
    await expect(service.lifecycle.attach(crew, "thr_nope", "dev-review")).rejects.toThrow(/no thread thr_nope/);
  });

  it("--replace retires and archives the member's old thread", async () => {
    const t = await trio();
    t.port.addForeign({ id: "thr_free", projectId: PROJECT });
    await t.service.lifecycle.attach(t.crew, "thr_free", "dev-review", { replace: true });
    expect(t.thread(t.threads["dev-review"]!)).toMatchObject({ archived: true });
    expect(t.thread(t.threads["dev-review"]!).metadata.retired).toBe(true);
  });
});

describe("add and remove member", () => {
  it("add member changes the crew file and applies: a new thread under the lead", async () => {
    const t = await trio();
    const outcome = await t.service.lifecycle.addMember(t.crew, { group: "dev", id: "docs", role: "Writes docs." });
    const added = outcome.results.find((r) => r.key === "dev-docs")!;
    expect(added.result).toBe("spawned");
    expect(t.thread(added.threadId!).parentThreadId).toBe(t.threads["orch-lead"]);
    expect(outcome.results.filter((r) => r.key !== "dev-docs").every((r) => r.result === "reused")).toBe(true);
    expect(outcome.crew.fileVersion).toBe(2);
    expect(t.store.crewFile(t.crew.id)!.yaml).toContain("id: docs");
  });

  it("negative: a duplicate member and permissions full without confirmation are refused, the file stays", async () => {
    const t = await trio();
    await expect(t.service.lifecycle.addMember(t.crew, { group: "dev", id: "impl" })).rejects.toThrow(CrewFileEditError);
    await expect(t.service.lifecycle.addMember(t.crew, { group: "dev", id: "root", permissions: "full" })).rejects.toThrow(/--confirm-full/);
    expect(t.store.getCrew(t.crew.id)!.fileVersion).toBe(1);
    const confirmed = await t.service.lifecycle.addMember(t.crew, { group: "dev", id: "root", permissions: "full" }, { confirmFull: true });
    expect(confirmed.results.find((r) => r.key === "dev-root")!.result).toBe("spawned");
  });

  it("remove member applies the smaller file: the thread is archived with retired: true, never deleted", async () => {
    const t = await trio();
    const outcome = await t.service.lifecycle.removeMember(t.crew, "dev-review");
    expect(outcome.results.find((r) => r.key === "dev-review")).toMatchObject({ result: "removed", detail: "archived" });
    expect(t.thread(t.threads["dev-review"]!)).toMatchObject({ archived: true });
    expect(t.thread(t.threads["dev-review"]!).metadata.retired).toBe(true);
    expect(t.port.threads.has(t.threads["dev-review"]!)).toBe(true);
    expect(t.store.listMembers(t.crew.id).map((m) => m.key)).toEqual(["orch-lead", "dev-impl"]);
    expect(t.store.crewFile(t.crew.id)!.yaml).not.toContain("dev-review");
  });

  it("negative: the lead cannot be removed", async () => {
    const t = await trio();
    await expect(t.service.lifecycle.removeMember(t.crew, "orch-lead")).rejects.toThrow(/is the lead/);
  });
});

describe("crew file edits", () => {
  const base = "# my crew\nversion: '1'\nname: c\nprovider: p\nmodel: m\ngroups:\n  - id: g # the only group\n    members:\n      - id: a\n        lead: true\n      - id: b\nlinks:\n  - { from: g-a, to: g-b, kind: assigns_to }\n";
  it("keeps comments; adds a new group when needed", () => {
    const added = addMemberToFile(base, { group: "h", id: "c", role: "New." });
    expect(added).toContain("# my crew");
    expect(added).toContain("# the only group");
    expect(added).toMatch(/- id: h\n\s+members:\n\s+- id: c\n\s+role: New\./);
  });
  it("remove drops the member's links and an emptied group", () => {
    const removed = removeMemberFromFile(addMemberToFile(base, { group: "h", id: "c" }), "h-c");
    expect(removed).not.toContain("id: h");
    const noB = removeMemberFromFile(base, "g-b");
    expect(noB).not.toContain("g-b");
    expect(noB).toContain("id: a");
  });
  it("negative: unknown member, bad ids", () => {
    expect(() => removeMemberFromFile(base, "g-z")).toThrow(/no member g-z/);
    expect(() => addMemberToFile(base, { group: "g", id: "a.b" })).toThrow(/letters, digits/);
  });
});

describe("export and import", () => {
  it("export → import in the same project: the same crew, same version, plan reports no change", async () => {
    const t = await trio();
    const yaml = t.service.lifecycle.exportFile(t.crew);
    const imported = await t.service.lifecycle.importFile(PROJECT, yaml);
    expect(imported.changed).toBe(false);
    expect(imported.crew!.fileVersion).toBe(1);
    expect(imported.items.map((item) => item.action)).toEqual(["reuse", "reuse", "reuse"]);
    expect(t.port.countCalls("spawn")).toBe(3);
  });

  it("import into another project creates the crew without threads; apply there spawns", async () => {
    const t = await trio();
    const yaml = t.service.lifecycle.exportFile(t.crew);
    const imported = await t.service.lifecycle.importFile("proj_2", yaml);
    expect(imported.crew).toMatchObject({ projectId: "proj_2", name: "trio", status: "stopped" });
    expect(imported.items.map((item) => item.action)).toEqual(["spawn", "spawn", "spawn"]);
    expect(t.port.countCalls("spawn")).toBe(3);
  });

  it("negative: an invalid file is not stored", async () => {
    const t = await trio();
    const imported = await t.service.lifecycle.importFile(PROJECT, trioYaml({ groups: [] }));
    expect(imported.crew).toBeNull();
    expect(imported.validation.problems.length).toBeGreaterThan(0);
  });
});

describe("open all layout", () => {
  it("side by side up to three, a grid from four", () => {
    expect(openLayout(0)).toEqual([]);
    expect(openLayout(1)).toEqual(["replace"]);
    expect(openLayout(3)).toEqual(["replace", "right", "right"]);
    expect(openLayout(4)).toEqual(["replace", "right", "down", "down"]);
    expect(openLayout(5)).toEqual(["replace", "right", "right", "down", "down"]);
  });
});

describe("delivery during an apply", () => {
  it("a crew that is starting holds messages instead of failing them on a thread apply is about to unarchive", async () => {
    const t = await trio();
    await t.service.stop(t.store.getCrew(t.crew.id)!, { archive: true });
    const [row] = await t.service.send({ projectId: PROJECT, from: t.human, to: "dev-impl@trio", body: "x" });
    t.store.setCrewStatus(t.crew.id, "starting");
    await t.service.delivery.drain();
    expect(t.store.getMessage(row!.id)).toMatchObject({ status: "on_hold", hold: "crew-stopped" });
    expect(t.store.getMessage(row!.id)!.reason).toContain("starting");
    // negative: once running, the archived thread is a real failure again
    t.store.setCrewStatus(t.crew.id, "running");
    await t.service.delivery.drain();
    expect(t.store.getMessage(row!.id)!.status).toBe("failed");
  });
});
