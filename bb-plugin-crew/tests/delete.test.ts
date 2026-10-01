import { describe, expect, it } from "vitest";
import { runCli } from "../lib/cli";
import { CREW_METADATA_KEYS, DeleteRefused } from "../lib/service";
import { duoYaml, PROJECT, running, setup, trioYaml } from "./helpers";

const project = async (ref: string | null, ctx: { projectId?: string }) => ref ?? ctx.projectId ?? null;
const ctx = { projectId: PROJECT };

/** Tables that carry a crew id directly, and those keyed by member row. */
const CREW_TABLES = ["crew_files", "members", "links", "channel_messages", "work_items", "escalations", "crew_dependencies", "merge_requests", "snapshots"];
const MEMBER_TABLES = ["member_bindings", "member_ops", "member_needs", "member_env", "member_state", "handovers"];

type Db = ReturnType<typeof setup>["db"];
const count = (db: Db, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

/** Rows per table that belong to a crew (messages: own or cross-crew side). */
function footprint(db: Db, crewId: string): Record<string, number> {
  const out: Record<string, number> = { crews: count(db, "SELECT COUNT(*) AS n FROM crews WHERE id = ?", crewId) };
  for (const table of CREW_TABLES) out[table] = count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE crew_id = ?`, crewId);
  for (const table of MEMBER_TABLES) out[table] = count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE member_id IN (SELECT id FROM members WHERE crew_id = ?)`, crewId);
  out.work_transitions = count(db, "SELECT COUNT(*) AS n FROM work_transitions WHERE item_id IN (SELECT id FROM work_items WHERE crew_id = ?)", crewId);
  out.messages = count(db, "SELECT COUNT(*) AS n FROM messages WHERE from_crew = ? OR to_crew = ?", crewId, crewId);
  return out;
}

/** trio (task CRD-1) and duo in one project, both running, with data in every table. */
async function twoCrews() {
  const env = setup();
  const { service, port, store } = env;
  const trio = await running(service, port, trioYaml({ task: "CRD-1", waitsFor: [{ task: "CRD-7", until: "done" }] }));
  const duo = await running(service, port, duoYaml());
  for (const crew of [trio, duo]) {
    const lead = Object.values(crew.members).find((member) => member.lead)!;
    const other = Object.values(crew.members).find((member) => !member.lead)!;
    await service.send({ projectId: PROJECT, from: crew.self(lead.key), to: other.key, body: `internal ${crew.crew.name}` });
    service.channel.post(store.getCrew(crew.crew.id)!, crew.self(lead.key), `post ${crew.crew.name}`, null);
    const item = store.insertWork({ id: `wi_${crew.crew.name}`, crewId: crew.crew.id, title: "t", body: "b", ownerMember: other.id, createdBy: lead.id, tier: "p2", dueAt: null, taskKey: null });
    store.transitionWork(item.id, { state: "claimed" }, other.id, null);
    store.logEscalation({ crewId: crew.crew.id, subjectKind: "work", subjectId: item.id, rung: 1, target: lead.id });
    store.insertMerge({ id: `mr_${crew.crew.name}`, projectId: PROJECT, crewId: crew.crew.id, branch: `b/${crew.crew.name}`, base: "main", requestedBy: lead.id });
    store.updateMerge(`mr_${crew.crew.name}`, { state: "merged" });
    store.insertSnapshot({ id: `snap_${crew.crew.name}`, crewId: crew.crew.id, label: null, json: "{}" });
    store.setNeed(other.id, "merge-conflict", null);
    store.markBusy(other.id, true, 1);
    store.insertHandover({ id: `ho_${crew.crew.name}`, memberId: other.id, oldThread: "x", oldShift: 1 });
    store.updateHandover(`ho_${crew.crew.name}`, { state: "done" });
    store.insertOp({ opId: `op_extra_${crew.crew.name}`, memberId: other.id, kind: "note" });
  }
  // Cross-crew messages in both directions, stored whatever the policy says.
  const trioLead = trio.self("orch-lead");
  const duoLead = duo.self("core-lead");
  const toDuo = await service.send({ projectId: PROJECT, from: trioLead, to: "core-lead@duo", body: "from trio" });
  const toTrio = await service.send({ projectId: PROJECT, from: duoLead, to: "orch-lead@trio", body: "from duo" });
  return { ...env, trio, duo, toDuo: toDuo[0]!, toTrio: toTrio[0]! };
}

describe("bb crew delete — refusals", () => {
  it("refuses a running crew and names bb crew stop", async () => {
    const { service, trio } = await twoCrews();
    const crew = service.ctx.store.getCrew(trio.crew.id)!;
    await expect(service.delete(crew)).rejects.toThrow("run `bb crew stop trio` first");
    expect(service.ctx.store.getCrew(trio.crew.id)).not.toBeNull();
  });

  it("negative: a stopped crew without blockers is deleted", async () => {
    const { service, trio, store } = await twoCrews();
    await service.stop(store.getCrew(trio.crew.id)!);
    const result = await service.delete(store.getCrew(trio.crew.id)!);
    expect(result.warnings).toEqual([]);
    expect(store.getCrew(trio.crew.id)).toBeNull();
  });

  it("refuses while another crew waits for its task, names that crew; --force overrides with a warning", async () => {
    const env = setup();
    const trio = await running(env.service, env.port, trioYaml({ task: "CRD-1" }));
    await running(env.service, env.port, duoYaml({ waitsFor: [{ task: "CRD-1", until: "merged" }] }));
    await env.service.stop(env.store.getCrew(trio.crew.id)!);
    const crew = env.store.getCrew(trio.crew.id)!;
    const refusal = await env.service.delete(crew).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeleteRefused);
    expect((refusal as DeleteRefused).message).toContain("crew duo waits for CRD-1 until merged");
    expect((refusal as DeleteRefused).blockers).toEqual(["crew duo waits for CRD-1 until merged"]);
    expect(env.store.getCrew(trio.crew.id)).not.toBeNull();
    const forced = await env.service.delete(crew, { force: true });
    expect(forced.warnings).toEqual(["forced past: crew duo waits for CRD-1 until merged"]);
    expect(env.store.getCrew(trio.crew.id)).toBeNull();
    // The waiting crew's own dependency row is its data, not trio's.
    expect(env.store.listDependencies(env.store.findCrew(PROJECT, "duo")!.id)).toHaveLength(1);
  });

  it("negative: a satisfied waitsFor, or one on another task, does not block", async () => {
    const env = setup();
    const trio = await running(env.service, env.port, trioYaml({ task: "CRD-1" }));
    const duo = await running(env.service, env.port, duoYaml({ waitsFor: [{ task: "CRD-1", until: "done" }, { task: "CRD-9", until: "done" }] }));
    env.store.satisfyDependency(duo.crew.id, "CRD-1", "done", "done");
    await env.service.stop(env.store.getCrew(trio.crew.id)!);
    expect(env.service.deleteBlockers(env.store.getCrew(trio.crew.id)!)).toEqual([]);
  });

  it("refuses while the crew has an open or returned merge request, names it", async () => {
    const { service, store, trio } = await twoCrews();
    store.insertMerge({ id: "mr_open", projectId: PROJECT, crewId: trio.crew.id, branch: "b/x", base: "main", requestedBy: "orch-lead" });
    store.insertMerge({ id: "mr_back", projectId: PROJECT, crewId: trio.crew.id, branch: "b/y", base: "main", requestedBy: "orch-lead" });
    store.updateMerge("mr_back", { state: "returned" });
    await service.stop(store.getCrew(trio.crew.id)!);
    const refusal = (await service.delete(store.getCrew(trio.crew.id)!).catch((error: unknown) => error)) as DeleteRefused;
    expect(refusal.blockers).toEqual(["merge request mr_open (open): b/x → main", "merge request mr_back (returned): b/y → main"]);
    expect(store.getCrew(trio.crew.id)).not.toBeNull();
    // Negative: merged and rejected ones are history, not blockers.
    store.updateMerge("mr_open", { state: "merged" });
    store.updateMerge("mr_back", { state: "rejected" });
    expect(service.deleteBlockers(store.getCrew(trio.crew.id)!)).toEqual([]);
  });

  it("negative: another crew's open merge request does not block this one", async () => {
    const { service, store, trio, duo } = await twoCrews();
    store.insertMerge({ id: "mr_duo_open", projectId: PROJECT, crewId: duo.crew.id, branch: "b/d", base: "main", requestedBy: "core-lead" });
    await service.stop(store.getCrew(trio.crew.id)!);
    expect(service.deleteBlockers(store.getCrew(trio.crew.id)!)).toEqual([]);
  });

  it("a failing thread leaves every row in place, a second run finishes", async () => {
    const { db, service, store, port, trio } = await twoCrews();
    await service.stop(store.getCrew(trio.crew.id)!);
    const original = port.archive;
    port.archive = async () => {
      throw new Error("BB is down");
    };
    const refusal = (await service.delete(store.getCrew(trio.crew.id)!).catch((error: unknown) => error)) as DeleteRefused;
    expect(refusal.message).toContain("Nothing was removed from the database");
    expect(footprint(db, trio.crew.id)).toMatchObject({ crews: 1, members: 3, messages: 4 });
    port.archive = original;
    await service.delete(store.getCrew(trio.crew.id)!);
    expect(store.getCrew(trio.crew.id)).toBeNull();
  });
});

describe("bb crew delete — threads", () => {
  async function stoppedTrio() {
    const env = await twoCrews();
    // A retired shift: reset --mode new gives dev-impl a second thread.
    await env.service.lifecycle.reset(env.store.getCrew(env.trio.crew.id)!, "dev-impl", "new");
    await env.service.stop(env.store.getCrew(env.trio.crew.id)!);
    const bound = env.store.crewThreads(env.trio.crew.id);
    return { ...env, bound };
  }

  it("archive (default): current and retired threads are archived, nothing is deleted", async () => {
    const { service, store, port, trio, bound } = await stoppedTrio();
    expect(bound.filter((entry) => entry.retired)).toHaveLength(1);
    const retired = bound.find((entry) => entry.retired)!.threadId;
    port.threads.get(retired)!.archived = false;
    const result = await service.delete(store.getCrew(trio.crew.id)!);
    expect(result.threads.map((entry) => entry.outcome).sort()).toEqual(["archived", "archived", "archived", "archived"]);
    for (const entry of bound) expect(port.threads.get(entry.threadId)!.archived).toBe(true);
    expect(port.countCalls("delete")).toBe(0);
  });

  it("archive: missing threads and already archived ones are reported, not errors", async () => {
    const { service, store, port, trio, bound } = await stoppedTrio();
    port.threads.delete(bound[0]!.threadId);
    const retired = bound.find((entry) => entry.retired)!.threadId;
    port.threads.get(retired)!.archived = true;
    const result = await service.delete(store.getCrew(trio.crew.id)!);
    const outcome = Object.fromEntries(result.threads.map((entry) => [entry.threadId, entry.outcome]));
    expect(outcome[bound[0]!.threadId]).toBe("missing");
    expect(outcome[retired]).toBe("already-archived");
    expect(store.getCrew(trio.crew.id)).toBeNull();
  });

  it("delete: sub-threads before their parent, the lead last; every thread is gone", async () => {
    const { service, store, port, trio, bound } = await stoppedTrio();
    const impl = store.currentBinding(trio.members["dev-impl"]!.id)!.threadId;
    port.addForeign({ id: "thr_sub", projectId: PROJECT, parentThreadId: impl });
    port.addForeign({ id: "thr_subsub", projectId: PROJECT, parentThreadId: "thr_sub" });
    const result = await service.delete(store.getCrew(trio.crew.id)!, { threads: "delete" });
    const order = port.calls.filter((call) => call.method === "delete").map((call) => call.args as string);
    expect(order.indexOf("thr_subsub")).toBeLessThan(order.indexOf("thr_sub"));
    expect(order.indexOf("thr_sub")).toBeLessThan(order.indexOf(impl));
    expect(order.at(-1)).toBe(trio.threads["orch-lead"]);
    for (const id of [...bound.map((entry) => entry.threadId), "thr_sub", "thr_subsub"]) expect(port.threads.has(id)).toBe(false);
    expect(result.threads.find((entry) => entry.threadId === impl)!.children).toBe(2);
    // Negative: the other crew's threads are untouched.
    const duoThreads = store.crewThreads(store.findCrew(PROJECT, "duo")!.id);
    expect(duoThreads).toHaveLength(2);
    for (const entry of duoThreads) expect(port.threads.has(entry.threadId)).toBe(true);
  });

  it("delete: already deleted threads are skipped without a delete call", async () => {
    const { service, store, port, trio, bound } = await stoppedTrio();
    for (const entry of bound) port.threads.delete(entry.threadId);
    const result = await service.delete(store.getCrew(trio.crew.id)!, { threads: "delete" });
    expect(result.threads.every((entry) => entry.outcome === "missing")).toBe(true);
    expect(port.countCalls("delete")).toBe(0);
    expect(store.getCrew(trio.crew.id)).toBeNull();
  });

  it("keep: threads stay as they are, only the crew metadata is cleared", async () => {
    const { service, store, port, trio, duo, bound } = await stoppedTrio();
    const impl = port.threads.get(store.currentBinding(trio.members["dev-impl"]!.id)!.threadId)!;
    impl.metadata.other = "stays";
    const archivedBefore = new Map(bound.map((entry) => [entry.threadId, port.threads.get(entry.threadId)!.archived]));
    const result = await service.delete(store.getCrew(trio.crew.id)!, { threads: "keep" });
    expect(result.threads.every((entry) => entry.outcome === "kept")).toBe(true);
    for (const entry of bound) {
      const thread = port.threads.get(entry.threadId)!;
      expect(thread.archived).toBe(archivedBefore.get(entry.threadId));
      for (const key of CREW_METADATA_KEYS) expect(key in thread.metadata).toBe(false);
    }
    expect(impl.metadata.other).toBe("stays");
    expect(port.countCalls("delete")).toBe(0);
    // Negative: duo's threads keep their crew metadata.
    const duoLead = port.threads.get(duo.threads["core-lead"]!)!;
    expect(duoLead.metadata.crew).toBe("duo");
  });
});

describe("bb crew delete — rows", () => {
  it("removes every row of the crew and leaves the other crew's rows exactly as they were", async () => {
    const { db, service, store, trio, duo } = await twoCrews();
    await service.stop(store.getCrew(trio.crew.id)!);
    const before = footprint(db, trio.crew.id);
    for (const table of [...CREW_TABLES, ...MEMBER_TABLES, "work_transitions", "messages"]) expect(before[table], table).toBeGreaterThan(0);
    const duoBefore = footprint(db, duo.crew.id);
    const result = await service.delete(store.getCrew(trio.crew.id)!);
    const after = footprint(db, trio.crew.id);
    expect(Object.values(after).every((n) => n === 0), JSON.stringify(after)).toBe(true);
    expect(result.rows.crews).toBe(1);
    // duo's footprint: everything equal except the directory note to its lead,
    // and the two cross-crew messages, which now point at a deleted side.
    const duoAfter = footprint(db, duo.crew.id);
    expect({ ...duoAfter, messages: 0 }).toEqual({ ...duoBefore, messages: 0 });
    expect(duoAfter.messages).toBe(duoBefore.messages + 1);
  });

  it("a cross-crew message of the other crew survives with the deleted side marked", async () => {
    const { service, store, trio, toDuo, toTrio } = await twoCrews();
    await service.stop(store.getCrew(trio.crew.id)!);
    const result = await service.delete(store.getCrew(trio.crew.id)!);
    const sent = store.getMessage(toDuo.id)!;
    const received = store.getMessage(toTrio.id)!;
    expect(sent.fromCrew).toBe(`deleted:${trio.crew.id}`);
    expect(sent.fromMember).toBeNull();
    expect(sent.body).toBe("from trio");
    expect(received.toCrew).toBe(`deleted:${trio.crew.id}`);
    expect(received.toMember).toBeNull();
    expect(result.rows["messages-marked"]).toBe(2);
    // Negative: trio's internal message is gone.
    expect(store.listMessages({ projectId: PROJECT }).some((row) => row.body === "internal trio")).toBe(false);
    expect(store.listMessages({ projectId: PROJECT }).some((row) => row.body === "internal duo")).toBe(true);
  });

  it("a cross-crew message still waiting for the deleted crew is rejected; negative: a delivered one keeps its status", async () => {
    const { service, store, trio, toTrio } = await twoCrews();
    await service.stop(store.getCrew(trio.crew.id)!);
    const waiting = store.insertMessage({
      ...store.getMessage(toTrio.id)!,
      id: "msg_wait",
      status: "on_hold",
      hold: "crew-stopped",
    });
    await service.delete(store.getCrew(trio.crew.id)!);
    expect(store.getMessage(waiting.id)).toMatchObject({ status: "rejected", reason: "recipient crew deleted", hold: null });
    expect(store.getMessage(toTrio.id)!.status).toBe(toTrio.status);
  });

  it("the other running crews' leads get a directory note; negative: a stopped crew's lead does not", async () => {
    const env = setup();
    const trio = await running(env.service, env.port, trioYaml());
    const duo = await running(env.service, env.port, duoYaml());
    const solo = await running(env.service, env.port, duoYaml({ name: "solo" }));
    await env.service.stop(env.store.getCrew(trio.crew.id)!);
    await env.service.stop(env.store.getCrew(solo.crew.id)!);
    const notes = () => env.store.listMessages({ projectId: PROJECT }).filter((row) => row.subject === "Directory: crew trio was deleted");
    expect(notes()).toHaveLength(0);
    await env.service.delete(env.store.getCrew(trio.crew.id)!);
    expect(notes().map((row) => row.toAddress)).toEqual([duo.members["core-lead"]!.address]);
    expect(notes()[0]!.kind).toBe("system");
  });
});

describe("bb crew delete — CLI", () => {
  const run = (service: ReturnType<typeof setup>["service"], argv: string[]) => runCli(service, argv, ctx, project);

  it("deletes a stopped crew and prints threads and rows", async () => {
    const { service, port } = setup();
    await running(service, port);
    await run(service, ["stop", "trio"]);
    const result = await run(service, ["delete", "trio", "--threads", "keep"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("trio: deleted (threads: keep)");
    expect(result.stdout).toMatch(/orch-lead\s+th_1\s+shift 1\s+kept/);
    expect(result.stdout).toMatch(/rows: .*crews 1/);
    expect((await run(service, ["list"])).stdout).not.toContain("trio");
  });

  it("negative: running crew, unknown crew, bad --threads and a blocked crew fail with exit 1", async () => {
    const { service, port, store } = setup();
    await running(service, port);
    expect((await run(service, ["delete", "trio"])).stderr).toContain("run `bb crew stop trio` first");
    expect((await run(service, ["delete", "nope"])).stderr).toContain('No crew "nope"');
    expect((await run(service, ["delete", "trio", "--threads", "shred"])).stderr).toContain("--threads must be one of archive, delete, keep");
    expect((await run(service, ["delete"])).exitCode).toBe(1);
    await run(service, ["stop", "trio"]);
    store.insertMerge({ id: "mr_1", projectId: PROJECT, crewId: store.findCrew(PROJECT, "trio")!.id, branch: "b", base: "main", requestedBy: "x" });
    const blocked = await run(service, ["delete", "trio"]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("merge request mr_1 (open)");
    expect(blocked.stderr).toContain("--force");
    const forced = await run(service, ["delete", "trio", "--force"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("warning: forced past: merge request mr_1 (open)");
  });
});

describe("bb crew delete — both sides", () => {
  it("a cross-crew message goes once both of its crews are deleted; negative: with one side left it stays", async () => {
    const { service, store, trio, duo, toDuo } = await twoCrews();
    await service.stop(store.getCrew(trio.crew.id)!);
    await service.stop(store.getCrew(duo.crew.id)!);
    await service.delete(store.getCrew(trio.crew.id)!);
    expect(store.getMessage(toDuo.id)).not.toBeNull();
    await service.delete(store.getCrew(duo.crew.id)!);
    expect(store.getMessage(toDuo.id)).toBeNull();
    expect(store.listMessages({ projectId: PROJECT })).toEqual([]);
  });
});
