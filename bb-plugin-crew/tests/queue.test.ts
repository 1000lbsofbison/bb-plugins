import { describe, expect, it } from "vitest";
import { mentionsIn } from "../lib/channel";
import { dueRung, RUNGS } from "../lib/queue";
import type { WorkItemRow } from "../lib/store";
import { PROJECT, running, setup, trioYaml } from "./helpers";

const human = { kind: "human" as const };
const MIN = 60_000;
const sends = (port: ReturnType<typeof setup>["port"]) => port.calls.filter((call) => call.method === "send");

/** trio with a 1-minute p0 period, so rung n is due after n minutes. */
async function crewWithQueue(overrides: Parameters<typeof trioYaml>[0] = {}) {
  const env = setup();
  const crew = await running(env.service, env.port, trioYaml({ followUps: { p0: 1 }, ...overrides }));
  const member = (key: string) => ({ kind: "member" as const, member: crew.members[key]! });
  return { ...env, ...crew, member };
}

const item = (overrides: Partial<WorkItemRow>): WorkItemRow => ({
  id: "wi_1",
  crewId: "c",
  title: "t",
  body: "",
  ownerMember: null,
  createdBy: "human",
  state: "open",
  tier: "p0",
  dueAt: null,
  taskKey: null,
  closureNote: null,
  epoch: 0,
  stateSince: 0,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe("work items", () => {
  it("create → claim → handoff → claim → done, every step in work_transitions", async () => {
    const { service, store, crew, member, members } = await crewWithQueue();
    const q = service.queue;
    const created = q.create(crew, member("orch-lead"), { title: "Build parser", owner: "dev-impl", tier: "p1" });
    expect(created).toMatchObject({ state: "open", ownerMember: members["dev-impl"]!.id, tier: "p1", createdBy: "orch-lead@trio" });
    q.claim(crew, member("dev-impl"), created.id);
    const handed = await q.handoff(crew, member("dev-impl"), created.id, "dev-review", "please check");
    expect(handed).toMatchObject({ state: "open", ownerMember: members["dev-review"]!.id, epoch: 1 });
    // The new owner is told, with the claim hint.
    expect(store.listMessages({ toMember: members["dev-review"]!.id }).at(-1)!.body).toContain(`crew_work_claim(id: "${created.id}")`);
    q.claim(crew, member("dev-review"), created.id);
    const done = q.done(crew, member("dev-review"), created.id, "looks good");
    expect(done).toMatchObject({ state: "done", closureNote: "looks good" });
    expect(store.listTransitions(created.id).map((t) => `${t.fromState ?? "-"}→${t.toState} ${t.actor}`)).toEqual([
      "-→open orch-lead@trio",
      "open→claimed dev-impl@trio",
      "claimed→open dev-impl@trio",
      "open→claimed dev-review@trio",
      "claimed→done dev-review@trio",
    ]);
    expect(q.list(crew).map((entry) => entry.id)).toEqual([]);
    expect(q.list(crew, { all: true }).map((entry) => entry.id)).toEqual([created.id]);
  });

  it("negative: members cannot take or close someone else's item, closed items stay closed, bad input is refused", async () => {
    const { service, crew, member } = await crewWithQueue();
    const q = service.queue;
    const created = q.create(crew, human, { title: "x", owner: "dev-impl" });
    expect(() => q.claim(crew, member("dev-review"), created.id)).toThrow("assigned to someone else");
    q.claim(crew, member("dev-impl"), created.id);
    expect(() => q.claim(crew, member("dev-review"), created.id)).toThrow("already claimed");
    expect(() => q.done(crew, member("dev-review"), created.id, "")).toThrow("not yours");
    expect(() => q.fail(crew, member("dev-impl"), created.id, " ")).toThrow("needs a reason");
    q.fail(crew, member("dev-impl"), created.id, "blocked");
    expect(() => q.done(crew, member("dev-impl"), created.id, "")).toThrow("is failed");
    expect(() => q.create(crew, human, { title: " " })).toThrow("needs a title");
    expect(() => q.create(crew, human, { title: "x", owner: "dev-ghost" })).toThrow('No member "dev-ghost"');
    expect(() => q.claim(crew, human, created.id)).toThrow();
  });

  it("the lead and the human may act on any item; the human claims on behalf of a member", async () => {
    const { service, crew, member } = await crewWithQueue();
    const q = service.queue;
    const a = q.create(crew, human, { title: "a", owner: "dev-impl" });
    expect(q.claim(crew, human, a.id, "dev-impl").state).toBe("claimed");
    expect(q.unclaim(crew, member("orch-lead"), a.id)).toMatchObject({ state: "open", ownerMember: null, epoch: 1 });
  });
});

describe("follow-up rungs", () => {
  it("dueRung: rung n after n periods, one rung at a time, nothing for closed or on-time claimed items", () => {
    const open = item({ stateSince: 0 });
    expect(dueRung(open, MIN, 0, MIN - 1)).toBeNull();
    expect(dueRung(open, MIN, 0, MIN)).toBe(1);
    expect(dueRung(open, MIN, 1, 2 * MIN - 1)).toBeNull();
    expect(dueRung(open, MIN, 1, 2 * MIN)).toBe(2);
    // After a long pause the sweep climbs one rung per pass, not all four at once.
    expect(dueRung(open, MIN, 0, 10 * MIN)).toBe(1);
    expect(dueRung(open, MIN, RUNGS, 10 * MIN)).toBeNull();
    expect(dueRung(item({ state: "done" }), MIN, 0, 10 * MIN)).toBeNull();
    expect(dueRung(item({ state: "claimed", dueAt: null }), MIN, 0, 10 * MIN)).toBeNull();
    expect(dueRung(item({ state: "claimed", dueAt: 5 * MIN }), MIN, 0, 5 * MIN + 1)).toBeNull();
    expect(dueRung(item({ state: "claimed", dueAt: 5 * MIN }), MIN, 0, 6 * MIN)).toBe(1);
  });

  it("an unclaimed item climbs all four rungs; each is logged and sent exactly once", async () => {
    const { service, store, port, crew, advance } = await crewWithQueue();
    const created = service.queue.create(crew, human, { title: "Write docs", owner: "dev-impl", tier: "p0" });
    expect(await service.followUps()).toEqual([]);
    const targets: string[] = [];
    for (let rung = 1; rung <= 4; rung += 1) {
      advance(MIN);
      const fired = await service.followUps();
      expect(fired).toEqual([{ item: created.id, rung, target: expect.any(String) }]);
      targets.push(fired[0]!.target);
      // A second sweep at the same moment changes nothing.
      expect(await service.followUps()).toEqual([]);
    }
    // 1, 2: the owner; 3: no escalates_to link, so the lead; 4: the lead's thread.
    expect(targets).toEqual(["dev-impl@trio", "dev-impl@trio", "orch-lead@trio", "orch-lead@trio"]);
    advance(10 * MIN);
    expect(await service.followUps()).toEqual([]);
    expect(store.listEscalations({ crewId: crew.id }).map((row) => row.rung)).toEqual([1, 2, 3, 4]);
    const subjects = store.listMessages().filter((m) => m.subject.startsWith("Follow-up")).map((m) => `${m.toAddress} ${m.subject}`);
    expect(subjects).toEqual([
      "dev-impl@trio Follow-up 1/4: Write docs",
      "dev-impl@trio Follow-up 2/4: Write docs",
      "orch-lead@trio Follow-up 3/4: Write docs",
      "orch-lead@trio Follow-up 4/4: Write docs",
    ]);
    // Reminders are messages without a chain of their own: each opens a new one, from the plugin.
    const rows = store.listMessages().filter((m) => m.subject.startsWith("Follow-up"));
    expect(new Set(rows.map((m) => m.chainId)).size).toBe(4);
    expect(rows.every((m) => m.fromAddress === "system" && m.kind === "message" && m.step === 1)).toBe(true);
    // They wake the recipient (a turn starts), unlike system notices.
    expect(sends(port).length).toBeGreaterThanOrEqual(4);
  });

  it("rung 4 puts the owner on Needs you (follow-up); before rung 4 it does not, and claiming clears it", async () => {
    const { service, crew, advance, member, members } = await crewWithQueue();
    const created = service.queue.create(crew, human, { title: "x", owner: "dev-impl", tier: "p0" });
    const needs = async () => (await service.activity.refreshMember(members["dev-impl"]!))!.needsYou;
    for (let rung = 1; rung <= 3; rung += 1) {
      advance(MIN);
      await service.followUps();
    }
    expect(await needs()).not.toContain("follow-up");
    advance(MIN);
    await service.followUps();
    expect(await needs()).toContain("follow-up");
    service.queue.claim(crew, member("dev-impl"), created.id);
    expect(await needs()).not.toContain("follow-up");
  });

  it("rung 3 goes along escalates_to when the owner has such a link", async () => {
    const { service, crew, advance } = await crewWithQueue({
      links: [
        { from: "orch-lead", to: "dev-impl", kind: "assigns_to" },
        { from: "dev-impl", to: "dev-review", kind: "escalates_to" },
      ],
    });
    service.queue.create(crew, human, { title: "x", owner: "dev-impl", tier: "p0" });
    const fired = [];
    for (let rung = 1; rung <= 3; rung += 1) {
      advance(MIN);
      fired.push(...(await service.followUps()));
    }
    expect(fired.at(-1)).toMatchObject({ rung: 3, target: "dev-review@trio" });
  });

  it("rung 3 for an item of the lead without escalates_to goes to the human; unassigned items remind the lead", async () => {
    const { service, crew, advance, store } = await crewWithQueue();
    service.queue.create(crew, human, { title: "lead's", owner: "orch-lead", tier: "p0" });
    service.queue.create(crew, human, { title: "nobody's", tier: "p0" });
    advance(MIN);
    expect((await service.followUps()).map((f) => f.target)).toEqual(["orch-lead@trio", "orch-lead@trio"]);
    advance(MIN);
    await service.followUps();
    advance(MIN);
    const third = await service.followUps();
    expect(third.map((f) => f.target)).toEqual(["human", "human"]);
    expect(store.listMessages({ status: "delivered" }).filter((m) => m.toAddress === "human").length).toBe(2);
  });

  it("negative: claimed on-time items, closed items and stopped crews get no follow-ups", async () => {
    const { service, crew, advance, member } = await crewWithQueue();
    const claimed = service.queue.create(crew, human, { title: "a", owner: "dev-impl", tier: "p0", dueAt: Date.UTC(2030, 0, 1) });
    service.queue.claim(crew, member("dev-impl"), claimed.id);
    const closed = service.queue.create(crew, human, { title: "b", owner: "dev-impl", tier: "p0" });
    service.queue.done(crew, member("dev-impl"), closed.id, "");
    advance(5 * MIN);
    expect(await service.followUps()).toEqual([]);
    service.queue.create(crew, human, { title: "c", tier: "p0" });
    await service.stop(crew);
    advance(5 * MIN);
    expect(await service.followUps()).toEqual([]);
  });

  it("a handoff starts a fresh set of rungs for the new owner", async () => {
    const { service, crew, advance, store } = await crewWithQueue();
    const created = service.queue.create(crew, human, { title: "x", owner: "dev-impl", tier: "p0" });
    advance(MIN);
    await service.followUps();
    await service.queue.handoff(crew, human, created.id, "dev-review", "");
    advance(MIN);
    expect(await service.followUps()).toEqual([{ item: created.id, rung: 1, target: "dev-review@trio" }]);
    expect(store.listEscalations().map((row) => `${row.subjectId} ${row.rung}`)).toEqual([`${created.id}#0 1`, `${created.id}#1 1`]);
  });
});

describe("channel", () => {
  it("a post wakes nobody; an @mention becomes one message to that member", async () => {
    const { service, port, crew, store, self } = await crewWithQueue();
    const before = sends(port).length;
    const plain = service.channel.post(crew, self("dev-impl"), "Parser is half done.", "status");
    await service.flush();
    expect(plain.mentions).toEqual([]);
    expect(sends(port).length).toBe(before);
    const mention = service.channel.post(crew, self("dev-impl"), "@dev-review can you look at the lexer? @nobody @dev-review");
    await service.flush();
    expect(mention.mentions.map((m) => m.toAddress)).toEqual(["dev-review@trio"]);
    expect(store.getMessage(mention.mentions[0]!.id)!.status).toBe("delivered");
    expect(sends(port).length).toBe(before + 1);
    expect(service.channel.read(crew).map((row) => row.author)).toEqual(["dev-impl@trio", "dev-impl@trio"]);
    expect(service.channel.read(crew, { topic: "status" }).map((row) => row.body)).toEqual(["Parser is half done."]);
    expect(service.channel.read(crew, { since: plain.post.createdAt }).map((row) => row.id)).toEqual([mention.post.id]);
  });

  it("mentions: only known keys, not e-mail addresses, not the author", () => {
    expect(mentionsIn("hi @dev-impl and @dev-review, mail a@dev-impl", ["dev-impl", "dev-review"])).toEqual(["dev-impl", "dev-review"]);
    expect(mentionsIn("@ghost hi", ["dev-impl"])).toEqual([]);
  });

  it("negative: the human may post, a member of another crew may not, empty posts are refused", async () => {
    const { service, crew, port } = await crewWithQueue();
    const other = await running(service, port, trioYaml({ name: "other" }));
    expect(service.channel.post(crew, human, "note from the human").post.author).toBe("human");
    expect(() => service.channel.post(crew, other.self("dev-impl"), "hi")).toThrow("own crew");
    expect(() => service.channel.post(crew, human, "  ")).toThrow("empty");
    expect(PROJECT).toBe("proj_1");
  });
});
