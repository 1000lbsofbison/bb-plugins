// Work queue and follow-ups (§3.6).
//
// The work itself lives in the item, never in chat text. Every state change
// writes a `work_transitions` row. Follow-ups climb four rungs for items that
// nobody claimed or that are overdue; `escalations` has a UNIQUE key per
// (item epoch, rung), so a rung fires exactly once however often the sweep
// runs — the sweep is idempotent and safe to call every minute or twice.
import { randomBytes } from "node:crypto";
import { AddressError, type Delivery, type Sender } from "./delivery";
import type { CrewModels } from "./policy";
import { followUpMinutes, TIERS, type Tier } from "./spec";
import type { CrewRow, MemberRow, Store, WorkItemRow, WorkState } from "./store";

export const OPEN_STATES: readonly WorkState[] = ["open", "claimed"];
export const RUNGS = 4;

export type Actor = { kind: "human" } | { kind: "member"; member: MemberRow };

export type QueueDeps = {
  store: Store;
  models: CrewModels;
  delivery: Delivery;
  now?: () => number;
  newId?: () => string;
};

export type Queue = ReturnType<typeof createQueue>;

const actorName = (actor: Actor) => (actor.kind === "human" ? "human" : actor.member.address);

/** The escalation subject of an item: a handoff or unclaim starts a fresh set of rungs. */
export const subjectOf = (item: Pick<WorkItemRow, "id" | "epoch">) => `${item.id}#${item.epoch}`;

/**
 * Which rung is due now, or null. The clock of an unclaimed item starts when
 * it became `open`; a claimed item is only followed up once it is overdue.
 * Rung n is due after n periods, and only the next rung after the last one
 * logged — a sweep after a long pause climbs one rung per pass, not four at once.
 */
export function dueRung(item: WorkItemRow, periodMs: number, lastRung: number, now: number): number | null {
  if (!OPEN_STATES.includes(item.state) || lastRung >= RUNGS) return null;
  let start: number;
  if (item.state === "open") start = item.stateSince;
  else if (item.dueAt !== null && now > item.dueAt) start = item.dueAt;
  else return null;
  const next = lastRung + 1;
  return now - start >= next * periodMs ? next : null;
}

export function createQueue(deps: QueueDeps) {
  const { store, models, delivery } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => `wi_${randomBytes(4).toString("hex")}`);

  function memberByKey(crew: CrewRow, key: string): MemberRow {
    const member = store.listMembers(crew.id).find((entry) => entry.key === key || entry.address === key);
    if (!member) throw new AddressError(`No member "${key}" in crew ${crew.name}.`);
    return member;
  }

  function requireItem(crew: CrewRow, id: string): WorkItemRow {
    const item = store.getWork(id);
    if (!item || item.crewId !== crew.id) throw new AddressError(`There is no work item "${id}" in crew ${crew.name}.`);
    return item;
  }

  function requireOpen(item: WorkItemRow): void {
    if (!OPEN_STATES.includes(item.state)) throw new AddressError(`Work item ${item.id} is ${item.state}.`);
  }

  /** Members act on their own items; the lead and the human on any item of the crew. */
  function requireOwnerOrLead(item: WorkItemRow, actor: Actor): void {
    if (actor.kind === "human" || actor.member.lead) return;
    if (item.ownerMember !== actor.member.id) throw new AddressError(`Work item ${item.id} is not yours; ask its owner or your lead.`);
  }

  function lead(crew: CrewRow): MemberRow | null {
    return store.listMembers(crew.id).find((member) => member.lead) ?? null;
  }

  async function notify(crew: CrewRow, to: MemberRow, subject: string, body: string, from: Sender = { kind: "system" }) {
    await delivery.send({ projectId: crew.projectId, from, to: to.address, subject, body, crew: crew.name });
  }

  return {
    create(
      crew: CrewRow,
      actor: Actor,
      input: { title: string; body?: string; owner?: string | null; tier?: Tier; dueAt?: number | null; taskKey?: string | null },
    ): WorkItemRow {
      const title = input.title.trim();
      if (!title) throw new AddressError("A work item needs a title.");
      const tier = input.tier ?? "p2";
      if (!TIERS.includes(tier)) throw new AddressError(`tier must be one of ${TIERS.join(", ")}.`);
      const owner = input.owner ? memberByKey(crew, input.owner) : null;
      return store.insertWork({
        id: newId(),
        crewId: crew.id,
        title: title.slice(0, 200),
        body: (input.body ?? "").slice(0, 20_000),
        ownerMember: owner?.id ?? null,
        createdBy: actorName(actor),
        tier,
        dueAt: input.dueAt ?? null,
        taskKey: input.taskKey ?? null,
      });
    },

    /** Claim for oneself; the human may claim on behalf of a member (`as`). */
    claim(crew: CrewRow, actor: Actor, id: string, as?: string): WorkItemRow {
      const item = requireItem(crew, id);
      requireOpen(item);
      const owner = actor.kind === "member" ? actor.member : as ? memberByKey(crew, as) : null;
      if (!owner) throw new AddressError("The human claims on behalf of a member: pass the member.");
      if (item.state === "claimed" && item.ownerMember === owner.id) return item;
      if (item.state === "claimed") throw new AddressError(`Work item ${id} is already claimed by someone else; ask for a handoff.`);
      if (item.ownerMember !== null && item.ownerMember !== owner.id && actor.kind === "member" && !actor.member.lead) {
        throw new AddressError(`Work item ${id} is assigned to someone else.`);
      }
      return store.transitionWork(id, { state: "claimed", owner: owner.id }, actorName(actor), null);
    },

    unclaim(crew: CrewRow, actor: Actor, id: string): WorkItemRow {
      const item = requireItem(crew, id);
      if (item.state !== "claimed") throw new AddressError(`Work item ${id} is ${item.state}, not claimed.`);
      requireOwnerOrLead(item, actor);
      return store.transitionWork(id, { state: "open", owner: null, bumpEpoch: true }, actorName(actor), null);
    },

    /** Hand to another member: the item waits for the new owner's claim, with fresh follow-ups. */
    async handoff(crew: CrewRow, actor: Actor, id: string, to: string, note: string): Promise<WorkItemRow> {
      const item = requireItem(crew, id);
      requireOpen(item);
      requireOwnerOrLead(item, actor);
      const target = memberByKey(crew, to);
      const after = store.transitionWork(id, { state: "open", owner: target.id, bumpEpoch: true }, actorName(actor), note || null);
      if (actor.kind !== "member" || actor.member.id !== target.id) {
        await notify(
          crew,
          target,
          `Work item ${id}: ${item.title}`,
          `${actorName(actor)} handed work item ${id} to you${note ? `: ${note}` : "."}\nClaim it with crew_work_claim(id: "${id}").`,
          actor.kind === "member" ? { kind: "member", member: actor.member, crew } : { kind: "human" },
        );
      }
      return after;
    },

    done(crew: CrewRow, actor: Actor, id: string, note: string): WorkItemRow {
      const item = requireItem(crew, id);
      requireOpen(item);
      requireOwnerOrLead(item, actor);
      return store.transitionWork(id, { state: "done", closureNote: note || null }, actorName(actor), note || null);
    },

    fail(crew: CrewRow, actor: Actor, id: string, reason: string): WorkItemRow {
      const item = requireItem(crew, id);
      requireOpen(item);
      requireOwnerOrLead(item, actor);
      if (!reason.trim()) throw new AddressError("fail needs a reason.");
      return store.transitionWork(id, { state: "failed", closureNote: reason }, actorName(actor), reason);
    },

    list(crew: CrewRow, filter: { all?: boolean; owner?: string } = {}): WorkItemRow[] {
      const owner = filter.owner ? memberByKey(crew, filter.owner).id : undefined;
      return store.listWork({ crewId: crew.id, states: filter.all ? undefined : OPEN_STATES, owner });
    },

    /**
     * One follow-up sweep over every running crew (§3.6). Returns the rungs it
     * logged. Rung 1 and 2: reminder to the owner (the lead for unassigned
     * items). Rung 3: to the owner's `escalates_to` target, else the lead,
     * else the human. Rung 4: the owner is on "Needs you" (see activity) and
     * the lead's thread gets a message.
     */
    async followUps(): Promise<{ item: string; rung: number; target: string }[]> {
      const fired: { item: string; rung: number; target: string }[] = [];
      for (const crew of store.listCrews()) {
        if (crew.status !== "running" && crew.status !== "degraded") continue;
        const spec = models(crew).spec;
        const crewLead = lead(crew);
        const links = store.listLinks(crew.id);
        for (const item of store.listWork({ crewId: crew.id, states: OPEN_STATES })) {
          const subject = subjectOf(item);
          const rung = dueRung(item, followUpMinutes(spec, item.tier) * 60_000, store.highestRung("work", subject), now());
          if (rung === null) continue;
          const owner = item.ownerMember ? store.getMember(item.ownerMember) : null;
          const reminded = owner ?? crewLead;
          let target: MemberRow | "human" | null = reminded;
          if (rung === 3) {
            const escalation = owner ? links.find((link) => link.kind === "escalates_to" && link.from === owner.key) : undefined;
            const via = escalation ? store.listMembers(crew.id).find((member) => member.key === escalation.to) ?? null : null;
            target = via ?? (crewLead && crewLead.id !== reminded?.id ? crewLead : "human");
          } else if (rung === 4) {
            target = crewLead;
          }
          const targetName = target === "human" ? "human" : (target?.address ?? "nobody");
          // Log first: if two sweeps race, only the one that logged sends.
          if (!store.logEscalation({ crewId: crew.id, subjectKind: "work", subjectId: subject, rung, target: targetName })) continue;
          fired.push({ item: item.id, rung, target: targetName });
          const why = item.state === "open" ? "is not claimed" : "is overdue";
          const text = `Work item ${item.id} "${item.title}" (${item.tier}) ${why}.`;
          const bodies: Record<number, string> = {
            1: `${text}\nClaim it with crew_work_claim(id: "${item.id}") or hand it on with crew_work_handoff.`,
            2: `Second reminder. ${text}\nClaim, hand off or fail it; the next step escalates.`,
            3: `Escalation: ${text} Owner: ${owner?.address ?? "nobody"}. Please take care of it.`,
            4: `Escalated to the human: ${text} Owner: ${owner?.address ?? "nobody"} is now on Needs you.`,
          };
          const subjectLine = `Follow-up ${rung}/${RUNGS}: ${item.title}`.slice(0, 200);
          if (target === "human") {
            await delivery.send({ projectId: crew.projectId, from: { kind: "system" }, to: "human", subject: subjectLine, body: bodies[rung]!, crew: crew.name });
          } else if (target) {
            await notify(crew, target, subjectLine, bodies[rung]!);
          }
        }
      }
      return fired;
    },

    /** Items of this member that reached rung 4 and still need someone: the member is on Needs you. */
    escalatedToHuman(member: MemberRow): WorkItemRow[] {
      return store
        .listWork({ crewId: member.crewId, states: OPEN_STATES })
        .filter((item) => (item.ownerMember ?? store.listMembers(member.crewId).find((m) => m.lead)?.id) === member.id)
        // Claiming an unclaimed item answers the escalation; a claimed item stays escalated while overdue.
        .filter((item) => item.state === "open" || (item.dueAt !== null && now() > item.dueAt))
        .filter((item) => store.highestRung("work", subjectOf(item)) >= RUNGS);
    },
  };
}

export function formatWorkItem(item: WorkItemRow, ownerAddress: (id: string | null) => string): string {
  return `${item.id} [${item.state}] ${item.tier} "${item.title}" owner ${ownerAddress(item.ownerMember)}${item.dueAt ? ` due ${new Date(item.dueAt).toISOString().slice(0, 16)}Z` : ""}${
    item.taskKey ? ` task ${item.taskKey}` : ""
  }${item.closureNote ? ` — ${item.closureNote}` : ""}`;
}

/** Short rules for queue, channel and delivery; part of the configure instruction and the kickoff brief. */
export function workRules(lead: boolean, integrator: boolean): string {
  return [
    "Work and channel:",
    "- Work items are the record of work, not chat. crew_work_list shows yours; claim before you start, finish with crew_work_done(note) or crew_work_fail(reason), pass on with crew_work_handoff(to, note). Unclaimed or overdue items are followed up and escalate.",
    "- crew_channel_post writes to the crew channel and wakes nobody; @member-key in the text sends that member a message. crew_channel_read(since) reads it.",
    "- After a merge into main, crew_rebase rebases your worktree; if it reports a conflict, resolve it or leave it — you are then on the human's list.",
    lead ? "- Deliver your crew branch with crew_deliver once the work is committed; the human (or the integrator) merges it into main." : "",
    integrator ? "- You are the integrator: crew_merges lists merge requests, crew_merge(id) merges one — only when its checks are green." : "",
  ]
    .filter(Boolean)
    .join("\n");
}
