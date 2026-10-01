import { describe, expect, it } from "vitest";
import { AddressError, MAX_ATTEMPTS, parseAddress, renderMessage, replyAddress } from "../lib/delivery";
import { effectiveCrossCrew, loopVerdict } from "../lib/policy";
import { duoYaml, PROJECT, running, setup, trioYaml } from "./helpers";

const human = { kind: "human" as const };
const sends = (port: ReturnType<typeof setup>["port"]) => port.calls.filter((call) => call.method === "send");
/** `queued` counts as delivered (§3.4); the fake thread turns active after the first send. */
const reached = (status: string) => (status === "queued" ? "delivered" : status);

describe("addresses", () => {
  it("parses member, member@crew, groups, the crew and the human", () => {
    expect(parseAddress("dev-impl")).toEqual({ kind: "member", key: "dev-impl", crew: null });
    expect(parseAddress("dev-impl@trio")).toEqual({ kind: "member", key: "dev-impl", crew: "trio" });
    expect(parseAddress("@group:dev")).toEqual({ kind: "broadcast", group: "dev", crew: null });
    expect(parseAddress("@group:dev@duo")).toEqual({ kind: "broadcast", group: "dev", crew: "duo" });
    expect(parseAddress("@crew")).toEqual({ kind: "broadcast", group: null, crew: null });
    expect(parseAddress("human")).toEqual({ kind: "human" });
  });
  it("negative: malformed addresses are refused", () => {
    for (const bad of ["@everyone", "@group:", "dev@", "dev impl", "@"]) expect(() => parseAddress(bad)).toThrow(AddressError);
  });
  it("negative: an unknown member or crew is an error, and nothing is stored", async () => {
    const { service, port, store } = setup();
    const { self } = await running(service, port);
    await expect(service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-nobody", body: "hi" })).rejects.toThrow('No member "dev-nobody"');
    await expect(service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl@nowhere", body: "hi" })).rejects.toThrow('no crew "nowhere"');
    expect(store.listMessages()).toEqual([]);
  });
  it("the human must qualify a key that exists in several crews", async () => {
    const { service, port } = setup();
    await running(service, port);
    await running(service, port, duoYaml({ groups: [{ id: "orch", members: [{ id: "lead", lead: true }] }] }));
    await expect(service.send({ projectId: PROJECT, from: human, to: "orch-lead", body: "hi" })).rejects.toThrow("several crews");
    const [row] = await service.send({ projectId: PROJECT, from: human, to: "orch-lead@duo", body: "hi" });
    expect(row!.status).toBe("delivered");
  });
});

describe("header", () => {
  it("renders from, to, time, msg, chain with step and the reply line", async () => {
    const { service, port } = setup();
    const { self, threads } = await running(service, port);
    const [row] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", subject: "Task", body: "Build it." });
    const text = port.threads.get(threads["dev-impl"]!)!.inbox[0]!.text;
    expect(text).toContain("[crew] From: orch-lead@trio → To: dev-impl@trio");
    expect(text).toMatch(/Sent: 2026-09-30T09:\d\dZ · msg msg_\d+ · chain ch_\d+ \(step 1\/6\)/);
    expect(text).toContain("Subject: Task\n---\nBuild it.\n---");
    expect(text).toContain(`Reply with crew_send(to: "orch-lead", reply_to: "${row!.id}"`);
    expect(text).not.toContain("URGENT");
  });
  it("across crews the reply address is qualified; from the human it is human; urgent is marked", () => {
    const base = {
      id: "msg_1", projectId: "p", chainId: "ch_1", step: 2, replyTo: null, kind: "message" as const,
      fromAddress: "orch-lead@trio", fromMember: "m", fromCrew: "c1", toAddress: "core-lead@duo", toMember: "n", toCrew: "c2",
      subject: "S", body: "B", priority: "urgent" as const, status: "pending" as const, reason: null, hold: null, deliveryMode: null,
      attempts: 0, lastError: null, forced: false, answeredAt: null, appendedTo: null, createdAt: 0, updatedAt: 0, deliveredAt: null,
    };
    expect(replyAddress(base)).toBe("orch-lead@trio");
    expect(replyAddress({ ...base, toCrew: "c1" })).toBe("orch-lead");
    expect(replyAddress({ ...base, fromAddress: "human", fromCrew: null })).toBe("human");
    expect(replyAddress({ ...base, fromAddress: "system", fromCrew: null })).toBeNull();
    const text = renderMessage(base, 6);
    expect(text).toContain("(step 2/6) · URGENT");
    expect(renderMessage({ ...base, kind: "system" }, 6)).toContain("no reply needed");
  });
});

describe("delivery by recipient state (§3.4 table)", () => {
  it("idle → send mode start, delivered", async () => {
    const { service, port } = setup();
    const { self, threads } = await running(service, port);
    const [row] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "go" });
    expect(row).toMatchObject({ status: "delivered", deliveryMode: "start", attempts: 1 });
    expect(port.threads.get(threads["dev-impl"]!)!.inbox.map((entry) => entry.mode)).toEqual(["start"]);
  });

  it("active → queue-if-active; queued counts as delivered and is never sent again", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port, trioYaml(), "active");
    const [row] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "go" });
    expect(row).toMatchObject({ status: "queued", deliveryMode: "queue-if-active" });
    await service.delivery.drain();
    await service.delivery.drain();
    expect(sends(port)).toHaveLength(1);
  });

  it("a second message in the same pass to a just-started thread is queued, not started twice", async () => {
    const { service, port, store } = setup();
    const { self, threads } = await running(service, port);
    service.delivery.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "one" });
    service.delivery.send({ projectId: PROJECT, from: self("dev-review"), to: "dev-impl", body: "two" });
    await service.delivery.drain();
    expect(port.threads.get(threads["dev-impl"]!)!.inbox.map((entry) => entry.mode)).toEqual(["start", "queue-if-active"]);
    expect(store.listMessages().map((m) => m.status)).toEqual(["delivered", "queued"]);
  });

  it("open interaction → on_hold; released after the answer and delivered exactly once", async () => {
    const { service, port } = setup();
    const { self, threads } = await running(service, port);
    const thread = port.threads.get(threads["dev-impl"]!)!;
    thread.interactions.push({ id: "int_1", kind: "approval", title: "Run rm -rf build?" });
    const [row] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "go" });
    expect(row).toMatchObject({ status: "on_hold", hold: "interaction" });
    expect(row!.reason).toContain("Run rm -rf build?");
    await service.delivery.drain();
    expect(sends(port)).toHaveLength(0);
    thread.interactions.length = 0;
    await service.delivery.drain();
    await service.delivery.drain();
    expect(sends(port)).toHaveLength(1);
    expect(service.ctx.store.getMessage(row!.id)).toMatchObject({ status: "delivered", hold: null, attempts: 1 });
  });

  it("crew stopped → on_hold until the next apply; negative: a running crew does not hold", async () => {
    const { service, port } = setup();
    const { self, crew } = await running(service, port);
    const [first] = await service.send({ projectId: PROJECT, from: human, to: "dev-impl@trio", body: "before stop" });
    expect(first!.status).toBe("delivered");
    await service.stop(service.ctx.store.getCrew(crew.id)!);
    const [row] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "while stopped" });
    expect(row).toMatchObject({ status: "on_hold", hold: "crew-stopped" });
    await service.apply(PROJECT, trioYaml());
    expect(service.ctx.store.getMessage(row!.id)!.status).not.toBe("on_hold");
    expect(sends(port)).toHaveLength(2);
  });

  it("archived or missing thread → failed with the reason", async () => {
    const { service, port } = setup();
    const { self, threads } = await running(service, port);
    port.threads.get(threads["dev-impl"]!)!.archived = true;
    port.threads.delete(threads["dev-review"]!);
    const [archived] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "x" });
    const [missing] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-review", body: "x" });
    expect(archived).toMatchObject({ status: "failed" });
    expect(archived!.reason).toContain("archived");
    expect(missing!.reason).toContain("is gone");
    expect(sends(port)).toHaveLength(0);
  });

  it("urgent steers only from the lead or the human; negative: from another member it is rejected", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port, trioYaml(), "active");
    const [lead] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "stop", priority: "urgent" });
    const [fromHuman] = await service.send({ projectId: PROJECT, from: human, to: "dev-impl@trio", body: "stop", priority: "urgent" });
    const [member] = await service.send({ projectId: PROJECT, from: self("dev-review"), to: "dev-impl", body: "stop", priority: "urgent" });
    expect(lead!.deliveryMode).toBe("steer-if-active");
    expect(fromHuman!.deliveryMode).toBe("steer-if-active");
    expect(member).toMatchObject({ status: "rejected", reason: "priority urgent is reserved for the lead and the human" });
    expect(sends(port)).toHaveLength(2);
  });

  it("system notices never start a turn: idle → UI only, active → queue-if-active", async () => {
    const { service, port, store } = setup();
    const { threads } = await running(service, port);
    const system = { kind: "system" as const };
    const [idle] = await service.send({ projectId: PROJECT, from: system, to: "dev-impl@trio", body: "fyi", kind: "system" });
    expect(idle).toMatchObject({ status: "delivered", deliveryMode: "ui" });
    expect(sends(port)).toHaveLength(0);
    port.threads.get(threads["dev-impl"]!)!.status = "active";
    const [active] = await service.send({ projectId: PROJECT, from: system, to: "dev-impl@trio", body: "fyi", kind: "system" });
    expect(active).toMatchObject({ status: "queued", deliveryMode: "queue-if-active" });
    expect(store.listMessages().every((m) => m.fromAddress === "system")).toBe(true);
  });

  it("a failed send stays pending and is retried, then gives up after MAX_ATTEMPTS", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    port.sendFailures.push(new Error("boom"));
    const [row] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "x" });
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });
    await service.delivery.drain();
    expect(service.ctx.store.getMessage(row!.id)).toMatchObject({ status: "delivered", attempts: 2, lastError: null });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) port.sendFailures.push(new Error("down"));
    const [doomed] = await service.send({ projectId: PROJECT, from: human, to: "dev-review@trio", body: "x" });
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await service.delivery.drain();
    expect(service.ctx.store.getMessage(doomed!.id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("after an interrupted attempt the thread is checked first: found → no resend; not found → resend", async () => {
    const { service, port, store } = setup();
    const { self, threads } = await running(service, port);
    const [row] = service.delivery.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "x" });
    // Simulate a crash after BB accepted the message but before the row was updated.
    store.updateMessage(row!.id, { attempt: true });
    port.threads.get(threads["dev-impl"]!)!.inbox.push({ text: `… msg ${row!.id} …`, mode: "start" });
    await service.delivery.drain();
    expect(store.getMessage(row!.id)).toMatchObject({ status: "delivered", reason: "found in the thread after an interrupted attempt" });
    expect(sends(port)).toHaveLength(0);

    const [other] = service.delivery.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-review", body: "y" });
    store.updateMessage(other!.id, { attempt: true });
    await service.delivery.drain();
    expect(sends(port)).toHaveLength(1);
  });
});

describe("loop protection", () => {
  it("pure rule: step 6 stops, step 5 passes; the hourly cap and a stopped chain stop too", () => {
    const base = { maxSteps: 6, chainCountLastHour: 0, maxPerHour: 20, chainStopped: null };
    expect(loopVerdict({ ...base, step: 5 })).toBeNull();
    expect(loopVerdict({ ...base, step: 6 })).toContain("maxSteps 6");
    expect(loopVerdict({ ...base, step: 2, chainCountLastHour: 19 })).toBeNull();
    expect(loopVerdict({ ...base, step: 2, chainCountLastHour: 20 })).toContain("last hour");
    expect(loopVerdict({ ...base, step: 1, chainStopped: "x" })).toBe("chain stopped: x");
  });

  it("two members answering each other forever stop at step 6 with stopped_loop and the sender needs you", async () => {
    const { service, port, store } = setup();
    const { self } = await running(service, port);
    const statuses: string[] = [];
    let last = (await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "dev-review", body: "ping" }))[0]!;
    statuses.push(reached(last.status));
    for (let i = 0; i < 6; i += 1) {
      const from = i % 2 === 0 ? "dev-review" : "dev-impl";
      const to = i % 2 === 0 ? "dev-impl" : "dev-review";
      last = (await service.send({ projectId: PROJECT, from: self(from), to, body: "pong", replyTo: last.id }))[0]!;
      statuses.push(`${last.step}:${reached(last.status)}`);
    }
    expect(statuses).toEqual(["delivered", "2:delivered", "3:delivered", "4:delivered", "5:delivered", "6:stopped_loop", "7:stopped_loop"]);
    expect(sends(port)).toHaveLength(5);
    expect(store.chainStop(last.chainId)!.reason).toContain("maxSteps 6");
    const views = await service.activity.refreshAll();
    const review = views.find((view) => view.key === "dev-review")!;
    const impl = views.find((view) => view.key === "dev-impl")!;
    expect(review.needsYou).toContain("loop");
    expect(review.diagnoses).toContain("Stopped: loop");
    expect(impl.needsYou).toContain("loop");
    expect((await service.needs(PROJECT)).map((view) => view.key).sort()).toEqual(["dev-impl", "dev-review"]);
  });

  it("the human's answer starts a new chain, so it is never caught by the loop", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port, trioYaml({ maxSteps: 2 }));
    const first = (await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "dev-review", body: "a" }))[0]!;
    const second = (await service.send({ projectId: PROJECT, from: self("dev-review"), to: "dev-impl", body: "b", replyTo: first.id }))[0]!;
    expect(second.status).toBe("stopped_loop");
    const answer = (await service.send({ projectId: PROJECT, from: human, to: "dev-impl@trio", body: "c", replyTo: second.id }))[0]!;
    expect(answer).toMatchObject({ status: "delivered", step: 1 });
    expect(answer.chainId).not.toBe(first.chainId);
  });

  it("the hourly cap per chain stops a chain that stays below maxSteps", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port, trioYaml({ maxSteps: 50, maxMessagesPerChainPerHour: 3 }));
    const root = (await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "task" }))[0]!;
    const replies = [];
    for (let i = 0; i < 3; i += 1) {
      replies.push((await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: `r${i}`, replyTo: root.id }))[0]!);
    }
    expect(replies.map((row) => `${row.step}:${reached(row.status)}`)).toEqual(["2:delivered", "2:delivered", "2:stopped_loop"]);
    expect(replies[2]!.reason).toContain("maxMessagesPerChainPerHour 3");
  });

  it("negative: below the cap and an hour later a new chain is not affected", async () => {
    const { service, port, advance } = setup();
    const { self } = await running(service, port, trioYaml({ maxSteps: 50, maxMessagesPerChainPerHour: 3 }));
    const root = (await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "task" }))[0]!;
    await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "r", replyTo: root.id });
    advance(3_700_000);
    const later = (await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "r", replyTo: root.id }))[0]!;
    expect(reached(later.status)).toBe("delivered");
  });

  it("a member's message answers the last one it received — once; after that it opens a new chain", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    const task = (await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "task" }))[0]!;
    const reply = (await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "done" }))[0]!;
    expect(reply).toMatchObject({ chainId: task.chainId, step: 2, replyTo: task.id, subject: `Re: ${task.subject}` });
    const fresh = (await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "new topic" }))[0]!;
    expect(fresh.step).toBe(1);
    expect(fresh.chainId).not.toBe(task.chainId);
  });

  it("negative: reply_to must be a message to or from the sender", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    const other = (await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-review", body: "x" }))[0]!;
    await expect(service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "y", replyTo: other.id })).rejects.toThrow("not sent to or by you");
    await expect(service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "y", replyTo: "msg_404" })).rejects.toThrow("no message");
  });
});

describe("broadcast", () => {
  it("fans out into one message per member with a shared chain and step, sender excluded", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    const rows = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "@crew", body: "standup" });
    expect(rows.map((row) => row.toAddress).sort()).toEqual(["dev-impl@trio", "dev-review@trio"]);
    expect(new Set(rows.map((row) => row.chainId)).size).toBe(1);
    expect(rows.every((row) => row.step === 1 && row.status === "delivered")).toBe(true);
  });
  it("a group broadcast reaches only that group; negative: an unknown group is an error", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    const rows = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "@group:orch", body: "hi" });
    expect(rows.map((row) => row.toAddress)).toEqual(["orch-lead@trio"]);
    await expect(service.send({ projectId: PROJECT, from: self("dev-impl"), to: "@group:ops", body: "hi" })).rejects.toThrow('no group "ops"');
    await expect(service.send({ projectId: PROJECT, from: self("orch-lead"), to: "@group:orch", body: "hi" })).rejects.toThrow("nobody but you");
  });
});

describe("messaging: links", () => {
  const linked = trioYaml({
    messaging: "links",
    links: [
      { from: "orch-lead", to: "dev-impl", kind: "assigns_to" },
      { from: "orch-lead", to: "dev-review", kind: "assigns_to" },
    ],
  });
  it("rejects a message without a link, stores the rejection and tells why", async () => {
    const { service, port, store } = setup();
    const { self } = await running(service, port, linked);
    const [row] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "dev-review", body: "psst" });
    expect(row!.status).toBe("rejected");
    expect(row!.reason).toContain("no link between dev-impl and dev-review");
    expect(store.listMessages({ status: "rejected" })).toHaveLength(1);
    expect(sends(port)).toHaveLength(0);
  });
  it("allows a linked pair (either direction), the lead both ways and the human", async () => {
    const { service, port } = setup();
    const withLink = trioYaml({
      messaging: "links",
      links: [{ from: "dev-review", to: "dev-impl", kind: "works_with" }],
    });
    const { self } = await running(service, port, withLink);
    const results = [
      await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "dev-review", body: "a" }),
      await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "orch-lead", body: "b" }),
      await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-review", body: "c" }),
      await service.send({ projectId: PROJECT, from: human, to: "dev-review@trio", body: "d" }),
    ].map((rows) => reached(rows[0]!.status));
    expect(results).toEqual(["delivered", "delivered", "delivered", "delivered"]);
  });
  it("negative: under messaging open the same unlinked pair may talk", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port, trioYaml({ links: [] }));
    const [row] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "dev-review", body: "psst" });
    expect(row!.status).toBe("delivered");
  });
});

describe("crossCrew", () => {
  async function twoCrews(trio: Parameters<typeof trioYaml>[0] = {}, duo: Parameters<typeof duoYaml>[0] = {}) {
    const env = setup();
    const a = await running(env.service, env.port, trioYaml(trio));
    const b = await running(env.service, env.port, duoYaml(duo));
    return { ...env, a, b };
  }

  it("leads (default): lead to lead is delivered; a non-lead is rejected and the rejection is stored with both crews", async () => {
    const { service, a, b, store } = await twoCrews();
    const [ok] = await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "core-lead@duo", body: "sync?" });
    expect(ok!.status).toBe("delivered");
    const [refused] = await service.send({ projectId: PROJECT, from: a.self("dev-impl"), to: "core-lead@duo", body: "hi" });
    expect(refused).toMatchObject({ status: "rejected", fromCrew: a.crew.id, toCrew: b.crew.id });
    expect(refused!.reason).toContain("crossCrew: leads");
    const [leadToMember] = await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "core-dev@duo", body: "hi" });
    expect(leadToMember!.status).toBe("rejected");
    expect(store.listMessages({ crossCrew: true, status: "rejected" }).map((m) => m.id)).toEqual([refused!.id, leadToMember!.id]);
  });

  it("open on both sides lets any member talk across crews", async () => {
    const { service, a } = await twoCrews({ crossCrew: "open" }, { crossCrew: "open" });
    const [row] = await service.send({ projectId: PROJECT, from: a.self("dev-impl"), to: "core-dev@duo", body: "hi" });
    expect(row!.status).toBe("delivered");
  });

  it("the stricter crew wins: open towards leads is still leads-only", async () => {
    expect(effectiveCrossCrew("open", "leads")).toBe("leads");
    expect(effectiveCrossCrew("leads", "none")).toBe("none");
    expect(effectiveCrossCrew("open", "open")).toBe("open");
    const { service, a } = await twoCrews({ crossCrew: "open" }, {});
    const [row] = await service.send({ projectId: PROJECT, from: a.self("dev-impl"), to: "core-dev@duo", body: "hi" });
    expect(row!.status).toBe("rejected");
  });

  it("none rejects even lead to lead, but the human stays reachable and may write in", async () => {
    const { service, a } = await twoCrews({ crossCrew: "none" });
    const [row] = await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "core-lead@duo", body: "hi" });
    expect(row!.reason).toContain("crossCrew: none");
    const [ask] = await service.send({ projectId: PROJECT, from: a.self("dev-impl"), to: "human", body: "Which API?" });
    expect(ask!.status).toBe("delivered");
    const [answer] = await service.send({ projectId: PROJECT, from: human, to: "dev-impl@trio", body: "v2" });
    expect(answer!.status).toBe("delivered");
  });

  it("a chain keeps its id across the crew border and maxSteps counts together", async () => {
    const { service, a, b } = await twoCrews({ maxSteps: 3 }, { maxSteps: 3 });
    const first = (await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "core-lead@duo", body: "1" }))[0]!;
    const second = (await service.send({ projectId: PROJECT, from: b.self("core-lead"), to: "orch-lead@trio", body: "2", replyTo: first.id }))[0]!;
    const third = (await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "core-lead@duo", body: "3", replyTo: second.id }))[0]!;
    expect([first.chainId, second.chainId, third.chainId]).toEqual([first.chainId, first.chainId, first.chainId]);
    expect([second.status, third.status]).toEqual(["delivered", "stopped_loop"]);
  });
});

describe("the human address", () => {
  it("a question to the human is stored as open and puts the sender on Needs you", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    const [ask] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", subject: "API", body: "v1 or v2?" });
    expect(ask).toMatchObject({ status: "delivered", deliveryMode: "ui", toMember: null, answeredAt: null, appendedTo: null });
    expect(sends(port)).toHaveLength(0);
    const view = (await service.activity.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).toEqual(["human-question"]);
    expect(view.activity).toBe("needs-you");
    expect(view.question).toBe("API: v1 or v2?");
  });

  it("at most one open question per member: a second one is appended to the first", async () => {
    const { service, port, store } = setup();
    const { self } = await running(service, port);
    const [first] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", subject: "API", body: "v1 or v2?" });
    const [second] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", subject: "Also", body: "tabs or spaces?" });
    expect(second!.appendedTo).toBe(first!.id);
    expect(store.getMessage(first!.id)!.body).toContain("Also: tabs or spaces?");
    expect(store.openHumanQuestion(self("dev-impl").member.id)!.id).toBe(first!.id);
    // negative: another member's question is its own
    const [other] = await service.send({ projectId: PROJECT, from: self("dev-review"), to: "human", body: "q" });
    expect(other!.appendedTo).toBeNull();
  });

  it("the human's reply arrives in the member thread, answers the question and clears Needs you", async () => {
    const { service, port, store } = setup();
    const { self, threads } = await running(service, port);
    const [ask] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", body: "v1 or v2?" });
    const [answer] = await service.send({ projectId: PROJECT, from: human, to: "dev-impl@trio", body: "v2" });
    expect(answer).toMatchObject({ status: "delivered", fromAddress: "human", step: 1, replyTo: ask!.id });
    expect(answer!.chainId).not.toBe(ask!.chainId);
    expect(store.getMessage(ask!.id)!.answeredAt).not.toBeNull();
    const text = port.threads.get(threads["dev-impl"]!)!.inbox[0]!.text;
    expect(text).toContain("[crew] From: human → To: dev-impl@trio");
    expect(text).toContain('crew_send(to: "human"');
    const view = (await service.activity.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).toEqual([]);
  });

  it("kind info: stored and shown as info, no Needs you, not an open question, nothing waits (BBP-23)", async () => {
    const { service, port, store } = setup();
    const { self } = await running(service, port);
    const [info] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", subject: "Status", body: "Tests green.", humanKind: "info" });
    expect(info).toMatchObject({ kind: "info", status: "delivered", deliveryMode: "ui", appendedTo: null });
    expect(sends(port)).toHaveLength(0);
    expect(store.openHumanQuestion(self("dev-impl").member.id)).toBeNull();
    const view = (await service.activity.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).toEqual([]);
    expect(await service.needs(PROJECT)).toEqual([]);
    // a later question is its own, not appended to the info
    const [ask] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", body: "v1 or v2?", humanKind: "question" });
    expect(ask).toMatchObject({ kind: "message", appendedTo: null });
    expect(store.openHumanQuestion(self("dev-impl").member.id)!.id).toBe(ask!.id);
    // the human's answer answers the question, not the info
    const [answer] = await service.send({ projectId: PROJECT, from: human, to: "dev-impl@trio", body: "v2" });
    expect(answer!.replyTo).toBe(ask!.id);
    expect(store.getMessage(info!.id)!.answeredAt).toBeNull();
  });

  it("kind question (explicit or default) still sets Needs you; negative: an info does not append to an open question", async () => {
    const { service, port, store } = setup();
    const { self } = await running(service, port);
    const [ask] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", body: "v1 or v2?", humanKind: "question" });
    expect(ask!.kind).toBe("message");
    const [info] = await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", body: "FYI: build is slow", humanKind: "info" });
    expect(info!.appendedTo).toBeNull();
    expect(store.getMessage(ask!.id)!.body).not.toContain("build is slow");
    const view = (await service.activity.refreshAll()).find((v) => v.key === "dev-impl")!;
    expect(view.needsYou).toEqual(["human-question"]);
    expect((await service.needs(PROJECT)).map((v) => v.key)).toEqual(["dev-impl"]);
  });

  it("negative: kind info to a member is refused and nothing is stored", async () => {
    const { service, port, store } = setup();
    const { self } = await running(service, port);
    await expect(service.send({ projectId: PROJECT, from: self("dev-impl"), to: "dev-review", body: "x", humanKind: "info" })).rejects.toThrow(
      'kind: "info" is only for messages to the human',
    );
    expect(store.listMessages()).toEqual([]);
  });

  it("negative: the human cannot write to the human", async () => {
    const { service, port } = setup();
    await running(service, port);
    await expect(service.send({ projectId: PROJECT, from: human, to: "human", body: "x" })).rejects.toThrow("cannot write to the human");
  });
});

describe("human interventions", () => {
  it("release delivers a held message despite the open interaction; discard drops one; stop-chain stops the rest", async () => {
    const { service, port, store } = setup();
    const { self, threads } = await running(service, port);
    port.threads.get(threads["dev-impl"]!)!.interactions.push({ id: "i", kind: "question", title: "?" });
    const [held] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "a" });
    const [dropped] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "b" });
    service.delivery.release(held!.id);
    service.delivery.discard(dropped!.id);
    await service.delivery.drain();
    expect(store.getMessage(held!.id)).toMatchObject({ status: "delivered", forced: true, reason: "released by the human" });
    expect(store.getMessage(dropped!.id)).toMatchObject({ status: "failed", reason: "discarded by the human" });
    expect(() => service.delivery.release(held!.id)).toThrow("only held or stopped");
    expect(() => service.delivery.discard(held!.id)).toThrow("can no longer be discarded");

    port.threads.get(threads["dev-review"]!)!.interactions.push({ id: "j", kind: "approval", title: "?" });
    const [waiting] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-review", body: "c" });
    const stopped = service.delivery.stopChain(waiting!.chainId);
    expect(stopped.map((m) => m.status)).toEqual(["stopped_loop"]);
    port.threads.get(threads["dev-review"]!)!.interactions.length = 0;
    await service.delivery.drain();
    expect(store.getMessage(waiting!.id)!.status).toBe("stopped_loop");
    // Stopped by the human on purpose: it does not ask for them again.
    const view = (await service.activity.refreshAll()).find((v) => v.key === "orch-lead")!;
    expect(view.needsYou).not.toContain("loop");
  });
});

describe("log", () => {
  it("filters by crew, chain, cross-crew and status; everything is kept, rejected and held included", async () => {
    const { service, port } = setup();
    const a = await running(service, port);
    await running(service, port, duoYaml());
    port.threads.get(a.threads["dev-review"]!)!.interactions.push({ id: "i", kind: "question", title: "?" });
    const [task] = await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "dev-impl", body: "task" });
    await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "dev-review", body: "held" });
    await service.send({ projectId: PROJECT, from: a.self("dev-impl"), to: "core-lead@duo", body: "cross" });
    // The directory notice to trio's lead when duo started is a system row of its own.
    expect(service.log(PROJECT).filter((m) => m.kind === "system").map((m) => m.subject)).toEqual(["Directory: crew duo started"]);
    expect(service.log(PROJECT).filter((m) => m.kind !== "system").map((m) => m.status)).toEqual(["delivered", "on_hold", "rejected"]);
    expect(service.log(PROJECT, { crew: "duo" }).map((m) => m.body)).toEqual(["cross"]);
    expect(service.log(PROJECT, { crossCrew: true }).map((m) => m.body)).toEqual(["cross"]);
    expect(service.log(PROJECT, { status: "on_hold" }).map((m) => m.body)).toEqual(["held"]);
    // dev-impl's next message answers the task it received, so "cross" is on the same chain.
    expect(service.log(PROJECT, { chainId: task!.chainId }).map((m) => m.body)).toEqual(["task", "cross"]);
    expect(service.log(PROJECT, { limit: 1 }).map((m) => m.body)).toEqual(["cross"]);
    expect(service.log("proj_other")).toEqual([]);
    expect(() => service.log(PROJECT, { crew: "nope" })).toThrow('No crew "nope"');
  });
});
