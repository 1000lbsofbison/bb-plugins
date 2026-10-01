import { describe, expect, it } from "vitest";
import { deriveActivity } from "../lib/activity";
import { toolsFor } from "../lib/agent";
import { limitLine, parseLimitStatus } from "../lib/capacity";
import { buildDirectory, directoryRefusal } from "../lib/directory";
import type { ThreadInfo } from "../lib/thread-port";
import { duoYaml, PROJECT, running, setup, trioYaml } from "./helpers";

const human = { kind: "human" as const };
const thread = (status: string): ThreadInfo => ({
  id: "th",
  projectId: "p",
  providerId: "claude-code",
  parentThreadId: null,
  title: null,
  status,
  archived: false,
  environmentId: null,
  lastReadAt: null,
  latestAttentionAt: 0,
});
const base = { interactions: [], humanQuestion: null, stoppedLoops: 0, held: 0 };
const usage = (fraction: number) => ({ usedTokens: fraction * 200_000, contextWindow: 200_000 });

describe("directory (§3.9.3)", () => {
  it("lists every crew with task, status, branch and lead", async () => {
    const { service, port, store } = setup();
    const alpha = await running(service, port, duoYaml({ name: "alpha", task: "CRD-1", summary: "Header schema" }));
    await running(service, port, duoYaml({ name: "beta", task: "CRD-2", waitsFor: [{ task: "CRD-1", until: "merged" }] }));
    const entries = buildDirectory(store, service.models, PROJECT);
    expect(entries.map((entry) => [entry.crew, entry.task, entry.status, entry.lead])).toEqual([
      ["alpha", "CRD-1", "running", "core-lead@alpha"],
      ["beta", "CRD-2", "running", "core-lead@beta"],
    ]);
    expect(entries[0]!.branch).toBe(store.memberEnv(alpha.members["core-lead"]!.id)!.branch);
    expect(entries[0]!.branch).toBeTruthy();
    expect(entries[1]!.waitsFor).toEqual([{ task: "CRD-1", until: "merged" }]);
    expect(entries[0]!.summary).toBe("Header schema");
  });

  it("visibility: leads always, other members only under crossCrew: open", () => {
    expect(directoryRefusal({ lead: true }, "leads")).toBeNull();
    expect(directoryRefusal({ lead: true }, "none")).toBeNull();
    expect(directoryRefusal({ lead: false }, "open")).toBeNull();
    expect(directoryRefusal({ lead: false }, "leads")).toContain("for leads");
    expect(directoryRefusal({ lead: false }, "none")).toContain("for leads");
    expect(toolsFor({ lead: true, config: {} }, { crossCrew: "leads" })).toContain("crew_directory");
    expect(toolsFor({ lead: false, config: {} }, { crossCrew: "leads" })).not.toContain("crew_directory");
    expect(toolsFor({ lead: false, config: {} }, { crossCrew: "open" })).toContain("crew_directory");
    expect(toolsFor({ lead: false, config: {} }, { crossCrew: "open" })).not.toContain("crew_deliver");
    expect(toolsFor({ lead: false, config: { integrator: true } }, { crossCrew: "leads" })).toContain("crew_merge");
    expect(toolsFor({ lead: false, config: { role: "integrator" } }, { crossCrew: "leads" })).not.toContain("crew_merge");
    expect(toolsFor({ lead: true, config: { role: "Plans." } }, { crossCrew: "leads" })).not.toContain("crew_merge");
  });

  it("a crew starting or stopping sends the other leads a non-waking directory note; the lead's kickoff has the directory", async () => {
    const { service, port, store } = setup();
    const alpha = await running(service, port, duoYaml({ name: "alpha", task: "CRD-1" }));
    const beta = await running(service, port, duoYaml({ name: "beta" }));
    const toAlpha = () => store.listMessages({ toMember: alpha.members["core-lead"]!.id }).map((m) => `${m.kind} ${m.subject} ${m.deliveryMode}`);
    expect(toAlpha()).toEqual(["system Directory: crew beta started ui"]);
    // Nobody but alpha's lead: beta's own members and alpha's dev get nothing.
    expect(store.listMessages({ toMember: alpha.members["core-dev"]!.id })).toEqual([]);
    await service.stop(beta.crew);
    expect(toAlpha().at(-1)).toBe("system Directory: crew beta stopped ui");
    const kickoff = port.threads.get(beta.threads["core-lead"]!)!.request!.prompt;
    expect(kickoff).toContain("Crews in this project");
    expect(kickoff).toContain("alpha");
    expect(port.threads.get(beta.threads["core-dev"]!)!.request!.prompt).not.toContain("Crews in this project");
  });
});

describe("deputy (§3.9.4)", () => {
  const withDeputy = (deputy: boolean) =>
    duoYaml({
      name: "alpha",
      leadBusyTimeout: 10,
      groups: [{ id: "core", members: [{ id: "lead", lead: true, ...(deputy ? { deputy: "core-dev" } : {}) }, { id: "dev" }] }],
    });

  it("a cross-crew message to a busy lead waits, then goes to the deputy after leadBusyTimeout", async () => {
    const { service, port, store, advance } = setup();
    const alpha = await running(service, port, withDeputy(true));
    const beta = await running(service, port, duoYaml({ name: "beta" }));
    port.threads.get(alpha.threads["core-lead"]!)!.status = "active";
    const [row] = await service.send({ projectId: PROJECT, from: beta.self("core-lead"), to: "core-lead@alpha", body: "Is the schema stable?" });
    expect(store.getMessage(row!.id)).toMatchObject({ status: "on_hold", hold: "lead-busy" });
    advance(9 * 60_000);
    await service.delivery.drain();
    expect(store.getMessage(row!.id)!.status).toBe("on_hold");
    advance(60_000);
    await service.delivery.drain();
    expect(store.getMessage(row!.id)).toMatchObject({ status: "delivered", toAddress: "core-dev@alpha", reason: expect.stringContaining("deputy core-dev") });
    expect(port.threads.get(alpha.threads["core-dev"]!)!.inbox.at(-1)!.text).toContain("Is the schema stable?");
  });

  it("negative: without a deputy, to an idle lead, or within the crew, nothing is held for the deputy", async () => {
    const plain = setup();
    const a = await running(plain.service, plain.port, withDeputy(false));
    const b = await running(plain.service, plain.port, duoYaml({ name: "beta" }));
    plain.port.threads.get(a.threads["core-lead"]!)!.status = "active";
    const [queued] = await plain.service.send({ projectId: PROJECT, from: b.self("core-lead"), to: "core-lead@alpha", body: "x" });
    expect(plain.store.getMessage(queued!.id)!.status).toBe("queued");

    const idle = setup();
    const c = await running(idle.service, idle.port, withDeputy(true));
    const d = await running(idle.service, idle.port, duoYaml({ name: "beta" }));
    const [direct] = await idle.service.send({ projectId: PROJECT, from: d.self("core-lead"), to: "core-lead@alpha", body: "x" });
    expect(idle.store.getMessage(direct!.id)).toMatchObject({ status: "delivered", toAddress: "core-lead@alpha" });

    idle.port.threads.get(c.threads["core-lead"]!)!.status = "active";
    const [inside] = await idle.service.send({ projectId: PROJECT, from: c.self("core-dev"), to: "core-lead", body: "x" });
    expect(idle.store.getMessage(inside!.id)!.status).toBe("queued");
  });
});

describe("thread limit (§3.9.5)", () => {
  it("reads the tighter of BB's global and host limits", () => {
    expect(parseLimitStatus('{"globalLimit":null,"hosts":[{"status":"connected","effectiveLimit":16}]}')).toBe(16);
    expect(parseLimitStatus('{"globalLimit":4,"hosts":[{"status":"connected","effectiveLimit":16}]}')).toBe(4);
    expect(parseLimitStatus('{"globalLimit":null,"hosts":[]}')).toBeNull();
    expect(parseLimitStatus("not json")).toBeNull();
  });

  it("at the limit a turn-starting delivery is throttled; leads and the human go first when a slot frees", async () => {
    const { service, port, store } = setup({ bbLimit: 1 });
    const { threads, self } = await running(service, port);
    port.threads.get(threads["dev-impl"]!)!.status = "active"; // the one running thread
    const [toReview] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "dev-review", body: "routine" });
    const [toLead] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "cross-crew agreement" });
    expect(store.getMessage(toReview!.id)).toMatchObject({ status: "throttled", reason: expect.stringContaining("thread limit 1") });
    expect(store.getMessage(toLead!.id)!.status).toBe("throttled");
    // Queueing behind a running turn needs no slot.
    const [queued] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "busy one" });
    expect(store.getMessage(queued!.id)!.status).toBe("queued");
    // A slot frees: the lead's message goes first, the routine one keeps waiting.
    port.threads.get(threads["dev-impl"]!)!.status = "idle";
    await service.delivery.drain();
    expect(store.getMessage(toLead!.id)!.status).toBe("delivered");
    expect(store.getMessage(toReview!.id)!.status).toBe("throttled");
    const view = await service.activity.refreshMember(service.ctx.store.getMember(toReview!.toMember!)!);
    expect(view!.diagnoses).toContain("Throttled");
    expect(view!.needsYou).toEqual([]);
  });

  it("negative: no readable limit throttles nothing; the plugin-side limit overrides BB's", async () => {
    const open = setup({ bbLimit: null });
    const a = await running(open.service, open.port);
    open.port.threads.get(a.threads["dev-impl"]!)!.status = "active";
    const [row] = await open.service.send({ projectId: PROJECT, from: a.self("dev-impl"), to: "dev-review", body: "x" });
    expect(open.store.getMessage(row!.id)!.status).toBe("delivered");
    open.store.setSetting("threadLimit", "1");
    expect(await open.service.limit()).toEqual({ limit: 1, source: "plugin" });
    const [second] = await open.service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "dev-review", body: "y" });
    // dev-review is running now (first message), so this one queues; the throttle only bites on new turns.
    expect(open.store.getMessage(second!.id)!.status).toBe("queued");
  });

  it("plan and apply warn when the running crews' members exceed the limit, and not below it", async () => {
    const tight = setup({ bbLimit: 4 });
    await running(tight.service, tight.port);
    const planned = await tight.service.plan(PROJECT, duoYaml());
    expect(planned.validation.problems.find((p) => p.code === "thread-limit")?.message).toContain("5 members in running crews vs BB limit 4");
    const applied = await tight.service.apply(PROJECT, duoYaml());
    expect(applied.validation.problems.some((p) => p.code === "thread-limit")).toBe(true);

    const roomy = setup({ bbLimit: 16 });
    await running(roomy.service, roomy.port);
    const fine = await roomy.service.plan(PROJECT, duoYaml());
    expect(fine.validation.problems.some((p) => p.code === "thread-limit")).toBe(false);
    expect(fine.limit).toContain("5 members in running crews vs BB limit 16");
    expect(limitLine(3, { limit: null, source: "unknown" }).text).toContain("not readable");
  });
});

describe("activity: open work and context thresholds", () => {
  it("Idle with open work: only idle members that own open items", () => {
    expect(deriveActivity({ ...base, thread: thread("idle"), openWork: 2 }).diagnoses).toContain("Idle with open work");
    expect(deriveActivity({ ...base, thread: thread("active"), openWork: 2 }).diagnoses).not.toContain("Idle with open work");
    expect(deriveActivity({ ...base, thread: thread("idle"), openWork: 0 }).diagnoses).not.toContain("Idle with open work");
  });

  it("lead: handover suggested from 60 %, Needs you from 80 %", () => {
    const lead = (fraction: number) => deriveActivity({ ...base, thread: thread("idle"), lead: true, context: usage(fraction) });
    expect(lead(0.59).diagnoses).not.toContain("Handover suggested");
    expect(lead(0.6).diagnoses).toContain("Handover suggested");
    expect(lead(0.79).needsYou).not.toContain("context");
    expect(lead(0.8).needsYou).toContain("context");
    expect(lead(0.8).context).toBeCloseTo(0.8);
  });

  it("members: handover suggested from 80 %, never Needs you for context; unknown usage is silent", () => {
    const member = (fraction: number) => deriveActivity({ ...base, thread: thread("idle"), lead: false, context: usage(fraction) });
    expect(member(0.79).diagnoses).not.toContain("Handover suggested");
    expect(member(0.8).diagnoses).toContain("Handover suggested");
    expect(member(0.95).needsYou).not.toContain("context");
    const unknown = deriveActivity({ ...base, thread: thread("idle"), lead: true, context: null });
    expect(unknown.context).toBeNull();
    expect(unknown.diagnoses).toEqual([]);
  });

  it("the tracker reads context usage from BB and work items from the queue", async () => {
    const { service, port } = setup();
    const { crew, members, threads } = await running(service, port, trioYaml());
    port.usage.set(threads["orch-lead"]!, usage(0.85));
    service.queue.create(crew, human, { title: "x", owner: "dev-impl" });
    const lead = await service.activity.refreshMember(members["orch-lead"]!);
    expect(lead!.needsYou).toContain("context");
    const dev = await service.activity.refreshMember(members["dev-impl"]!);
    expect(dev!.openWork).toBe(1);
    expect(dev!.diagnoses).toContain("Idle with open work");
  });
});
