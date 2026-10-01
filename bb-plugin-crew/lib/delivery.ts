// Messaging (§3.4): addressing, routing, header, loop protection, delivery.
//
// `send` only writes rows — every message lands in `messages` first, refused
// ones included (§3.9.6). `drain` hands pending rows to BB through the
// ThreadPort according to the recipient's state. The row carries the
// obligation exactly once; the send itself is at-least-once, deduplicated by
// `attempts` plus a look into the thread for the message id before any retry.
import { randomBytes } from "node:crypto";
import { loopVerdict, routeRefusal, type CrewModels, type CrewPolicy, type Party } from "./policy";
import type { ResolvedMember } from "./spec";
import type {
  CrewRow,
  DeliveryMode,
  MemberRow,
  MessageKind,
  MessageRow,
  MessageStatus,
  NewMessage,
  Priority,
  Store,
} from "./store";
import type { SendMode, ThreadPort } from "./thread-port";

export const HUMAN = "human";
export const SYSTEM = "system";
const HOUR = 3_600_000;
/** Send attempts before a message is given up as `failed`. */
export const MAX_ATTEMPTS = 5;
const BUSY_STATUSES = new Set(["active", "pending", "starting", "stopping"]);

export class AddressError extends Error {}

export type Address =
  | { kind: "human" }
  | { kind: "member"; key: string; crew: string | null }
  | { kind: "broadcast"; group: string | null; crew: string | null };

/**
 * `dev-owner`, `dev-owner@crew`, `@group:dev`, `@crew`, `human`. A broadcast
 * may name another crew with a suffix: `@crew@other`, `@group:dev@other`.
 */
export function parseAddress(raw: string): Address {
  const text = raw.trim();
  if (text === HUMAN) return { kind: "human" };
  if (text.startsWith("@")) {
    const [head, crew = null] = text.slice(1).split("@") as [string, string?];
    if (head === "crew") return { kind: "broadcast", group: null, crew: crew || null };
    if (head.startsWith("group:") && head.length > 6) return { kind: "broadcast", group: head.slice(6), crew: crew || null };
    throw new AddressError(`"${raw}" is not an address. Use a member (dev-impl), member@crew, @group:<id>, @crew or human.`);
  }
  const at = text.indexOf("@");
  const key = at === -1 ? text : text.slice(0, at);
  const crew = at === -1 ? null : text.slice(at + 1);
  if (!key || crew === "" || /\s/.test(text)) throw new AddressError(`"${raw}" is not an address.`);
  return { kind: "member", key, crew };
}

/** `plugin`: another BB plugin through the RPC contract (§4.8), e.g. Graph Studio; routed like the human. */
export type Sender =
  | { kind: "human" }
  | { kind: "system" }
  | { kind: "plugin"; name: string }
  | { kind: "member"; member: MemberRow; crew: CrewRow };

export const PLUGIN_PREFIX = "plugin:";

export type SendInput = {
  projectId: string;
  from: Sender;
  to: string;
  body: string;
  subject?: string;
  priority?: Priority;
  /** Message id this answers. Without it a member's message answers the last one it received, if that is still unanswered. */
  replyTo?: string | null;
  kind?: MessageKind;
  /**
   * Only for messages to the human: `info` is a status report (no Needs you,
   * nobody waits for an answer), `question` (default) opens a question.
   */
  humanKind?: "info" | "question";
  /** Crew that bare member keys and `@crew` refer to when the sender is not a member. */
  crew?: string | null;
};

/** Thread slots for this pass: `limit` null = unknown or unlimited, nothing is throttled. */
export type Capacity = { limit: number | null; running: number };

export type DeliveryDeps = {
  store: Store;
  port: ThreadPort;
  models: CrewModels;
  /** Read once per drain pass (§3.9.5). Absent = no limit. */
  capacity?: () => Promise<Capacity>;
  now?: () => number;
  newId?: (prefix: "msg" | "ch") => string;
};

export type Delivery = ReturnType<typeof createDelivery>;

const shortId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

function firstLine(text: string, max = 60): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line || "(no subject)";
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

/** Address a reply goes to, as seen from the recipient's crew. */
export function replyAddress(message: Pick<MessageRow, "fromAddress" | "fromCrew" | "toCrew">): string | null {
  if (message.fromAddress === SYSTEM) return null;
  if (message.fromAddress === HUMAN) return HUMAN;
  if (message.fromAddress.startsWith(PLUGIN_PREFIX)) return message.fromAddress;
  if (message.fromCrew !== null && message.fromCrew === message.toCrew) return message.fromAddress.split("@")[0]!;
  return message.fromAddress;
}

/** The text a member's thread receives: header, body, reply line (§3.4, `step` instead of hop). */
export function renderMessage(message: MessageRow, maxSteps: number): string {
  if (message.kind === "system") {
    return [`[crew] Notice for ${message.toAddress} · msg ${message.id} · no reply needed`, "---", message.body].join("\n");
  }
  const reply = replyAddress(message);
  const meta = [
    `Sent: ${stamp(message.createdAt)}`,
    `msg ${message.id}`,
    `chain ${message.chainId} (step ${message.step}/${maxSteps})`,
    ...(message.priority === "urgent" ? ["URGENT"] : []),
  ];
  return [
    `[crew] From: ${message.fromAddress} → To: ${message.toAddress}`,
    meta.join(" · "),
    `Subject: ${message.subject}`,
    "---",
    message.body,
    "---",
    reply !== null && reply.startsWith(PLUGIN_PREFIX)
      ? `From ${reply.slice(PLUGIN_PREFIX.length)} — answer in your reply text; the caller reads your final answer of this turn.`
      : reply === null
      ? "From the crew plugin — no reply needed. Act on it with the crew tools (crew_work_*, crew_rebase …)."
      : reply === HUMAN
      ? `If you need the human again: crew_send(to: "human", reply_to: "${message.id}", …). Do not send acknowledgements; a question puts you on the human's list, kind: "info" does not.`
      : `Reply with crew_send(to: "${reply}", reply_to: "${message.id}", …) — only if there is something to do; acknowledgements are not needed.`,
  ].join("\n");
}

type Target = { kind: "human" } | { kind: "member"; member: MemberRow; crew: CrewRow };

export function createDelivery(deps: DeliveryDeps) {
  const { store, port, models } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? shortId;

  function crewByName(projectId: string, name: string): CrewRow {
    const crew = store.findCrew(projectId, name);
    if (!crew) throw new AddressError(`There is no crew "${name}" in this project.`);
    return crew;
  }

  function resolveTargets(projectId: string, address: Address, home: CrewRow | null): Target[] {
    if (address.kind === "human") return [{ kind: "human" }];
    if (address.kind === "broadcast") {
      const crew = address.crew ? crewByName(projectId, address.crew) : home;
      if (!crew) throw new AddressError("A broadcast needs a crew: @crew@<crew> or --crew.");
      const members = store.listMembers(crew.id).filter((member) => address.group === null || member.groupId === address.group);
      if (address.group !== null && members.length === 0) throw new AddressError(`Crew ${crew.name} has no group "${address.group}".`);
      return members.map((member) => ({ kind: "member", member, crew }));
    }
    const crews = address.crew ? [crewByName(projectId, address.crew)] : home ? [home] : store.listCrews(projectId);
    const matches = crews.flatMap((crew) =>
      store
        .listMembers(crew.id)
        .filter((member) => member.key === address.key)
        .map((member) => ({ kind: "member" as const, member, crew })),
    );
    if (matches.length === 0) {
      throw new AddressError(`No member "${address.key}"${crews.length === 1 ? ` in crew ${crews[0]!.name}` : " in this project"}.`);
    }
    if (matches.length > 1) {
      throw new AddressError(`"${address.key}" exists in several crews (${matches.map((m) => m.crew.name).join(", ")}); write ${address.key}@<crew>.`);
    }
    return matches;
  }

  function party(target: Target | Sender): Party {
    if (target.kind === "plugin") return { kind: "human" };
    if (target.kind !== "member") return target;
    return { kind: "member", member: target.member, crew: target.crew, policy: models(target.crew).policy };
  }

  /** Parent message of a new one, which decides chain and step. */
  function parentOf(input: SendInput): MessageRow | null {
    const from = input.from;
    if (input.replyTo) {
      const parent = store.getMessage(input.replyTo);
      if (!parent) throw new AddressError(`There is no message "${input.replyTo}".`);
      if (from.kind === "member" && parent.toMember !== from.member.id && parent.fromMember !== from.member.id) {
        throw new AddressError(`Message ${input.replyTo} was not sent to or by you.`);
      }
      return parent;
    }
    if (from.kind !== "member") return null;
    const received = store.lastReceived(from.member.id);
    const sent = store.lastSent(from.member.id);
    // A plugin notice (reminders, "main moved", directory) is nobody's message to answer.
    if (!received || received.deliveredAt === null || received.fromAddress === SYSTEM) return null;
    return !sent || received.deliveredAt > sent.createdAt ? received : null;
  }

  function send(input: SendInput): MessageRow[] {
    const body = input.body.trim();
    if (!body) throw new AddressError("The message is empty.");
    const from = input.from;
    const home = from.kind === "member" ? from.crew : input.crew ? crewByName(input.projectId, input.crew) : null;
    const address = parseAddress(input.to);
    let targets = resolveTargets(input.projectId, address, home);
    if (from.kind === "member") targets = targets.filter((t) => t.kind !== "member" || t.member.id !== from.member.id);
    if (targets.length === 0) throw new AddressError(`"${input.to}" reaches nobody but you.`);
    if (from.kind === "human" && targets.some((t) => t.kind === "human")) throw new AddressError("The human cannot write to the human.");
    const info = input.humanKind === "info";
    if (info && targets.some((t) => t.kind !== "human")) throw new AddressError('kind: "info" is only for messages to the human.');

    const parent = parentOf(input);
    // A human message always opens a new chain, so a conversation with the
    // human can never trip the loop protection (§3.4).
    const inherits = parent !== null && from.kind === "member";
    const chainId = inherits ? parent.chainId : newId("ch");
    const step = inherits ? parent.step + 1 : 1;
    const subject = (input.subject?.trim() || (parent ? `Re: ${parent.subject.replace(/^(Re: )+/, "")}` : firstLine(body))).slice(0, 200);
    const priority = input.priority ?? "normal";
    const kind: MessageKind = info ? "info" : (input.kind ?? "message");
    const senderParty = party(from);
    const policy: CrewPolicy | null = senderParty.kind === "member" ? senderParty.policy : null;
    const links = from.kind === "member" ? store.listLinks(from.crew.id) : [];
    const chainCount = store.chainCountSince(chainId, now() - HOUR);
    const chainStop = store.chainStop(chainId);

    const rows: MessageRow[] = [];
    for (const target of targets) {
      const base: NewMessage = {
        id: newId("msg"),
        projectId: input.projectId,
        chainId,
        step,
        replyTo: parent?.id ?? null,
        kind,
        fromAddress:
          from.kind === "member" ? from.member.address : from.kind === "human" ? HUMAN : from.kind === "plugin" ? `${PLUGIN_PREFIX}${from.name}` : SYSTEM,
        fromMember: from.kind === "member" ? from.member.id : null,
        fromCrew: from.kind === "member" ? from.crew.id : null,
        toAddress: target.kind === "member" ? target.member.address : HUMAN,
        toMember: target.kind === "member" ? target.member.id : null,
        toCrew: target.kind === "member" ? target.crew.id : null,
        subject,
        body,
        priority,
        status: "pending",
        reason: null,
        appendedTo: null,
      };
      const verdict = decide(from, target, { senderParty, links, policy, step, chainCount, chainStop, priority });
      if (verdict.status === "stopped_loop" && !chainStop) store.stopChain(chainId, verdict.reason!);
      if (target.kind === "human" && verdict.status === "pending") {
        // A status report is shown as-is: not appended to, and not counted as, an open question.
        rows.push(info ? store.insertMessage({ ...base, status: "delivered", delivered: true, deliveryMode: "ui" }) : askHuman(base));
        continue;
      }
      if (from.kind === "human" && target.kind === "member" && verdict.status === "pending") {
        const answered = store.answerHumanQuestions(target.member.id);
        if (!input.replyTo && answered.length > 0) base.replyTo = answered[0]!;
      }
      rows.push(store.insertMessage({ ...base, status: verdict.status, reason: verdict.reason }));
    }
    return rows;
  }

  function decide(
    from: Sender,
    target: Target,
    context: {
      senderParty: Party;
      links: { from: string; to: string }[];
      policy: CrewPolicy | null;
      step: number;
      chainCount: number;
      chainStop: { reason: string } | null;
      priority: Priority;
    },
  ): { status: MessageStatus; reason: string | null } {
    if (context.priority === "urgent" && from.kind === "member" && !from.member.lead) {
      return { status: "rejected", reason: "priority urgent is reserved for the lead and the human" };
    }
    const refusal = routeRefusal(context.senderParty, party(target), context.links);
    if (refusal) return { status: "rejected", reason: refusal };
    // Loop protection guards member-to-member chains. Messages to the human
    // and from the human or the plugin are exempt.
    if (from.kind === "member" && target.kind === "member" && context.policy) {
      const loop = loopVerdict({
        step: context.step,
        maxSteps: context.policy.maxSteps,
        chainCountLastHour: context.chainCount,
        maxPerHour: context.policy.maxMessagesPerChainPerHour,
        chainStopped: context.chainStop?.reason ?? null,
      });
      if (loop) return { status: "stopped_loop", reason: loop };
    }
    return { status: "pending", reason: null };
  }

  /** At most one open question per member; a further one is appended to it (§3.4). */
  function askHuman(base: NewMessage): MessageRow {
    const open = base.fromMember ? store.openHumanQuestion(base.fromMember) : null;
    if (open) {
      store.updateMessage(open.id, { body: `${open.body}\n\n[added ${stamp(now())}] ${base.subject}: ${base.body}` });
      return store.insertMessage({
        ...base,
        status: "delivered",
        delivered: true,
        deliveryMode: "ui",
        appendedTo: open.id,
        reason: `appended to open question ${open.id}`,
      });
    }
    return store.insertMessage({ ...base, status: "delivered", delivered: true, deliveryMode: "ui" });
  }

  function maxStepsFor(message: MessageRow): number {
    const crewId = message.fromCrew ?? message.toCrew;
    const crew = crewId ? store.getCrew(crewId) : null;
    return crew ? models(crew).policy.maxSteps : 6;
  }

  /** One delivery attempt. `touched` holds threads this drain already sent to: they count as busy. */
  function isCrossCrew(message: MessageRow): boolean {
    return message.fromCrew !== null && message.toCrew !== null && message.fromCrew !== message.toCrew;
  }

  /** The deputy that answers other crews for this lead (§3.9.4), if the crew file names one. */
  function deputyOf(crew: CrewRow, lead: MemberRow): MemberRow | null {
    const resolved = models(crew).members.find((entry) => entry.key === lead.key);
    if (!resolved?.deputy) return null;
    return store.listMembers(crew.id).find((member) => member.key === resolved.deputy) ?? null;
  }

  async function deliverOne(message: MessageRow, touched: Set<string>, budget: Capacity | null): Promise<MessageRow> {
    const set = (patch: Parameters<Store["updateMessage"]>[1]) => {
      const unchanged =
        (patch.status === undefined || patch.status === message.status) &&
        (patch.reason === undefined || patch.reason === message.reason) &&
        (patch.hold === undefined || patch.hold === message.hold) &&
        !patch.delivered &&
        !patch.attempt &&
        patch.lastError === undefined;
      return unchanged ? message : store.updateMessage(message.id, patch);
    };
    if (!message.forced) {
      const stopped = store.chainStop(message.chainId);
      if (stopped) return set({ status: "stopped_loop", reason: `chain stopped: ${stopped.reason}`, hold: null });
    }
    const member = message.toMember ? store.getMember(message.toMember) : null;
    if (!member || member.removedAt !== null) return set({ status: "failed", reason: "the recipient is no longer a member", hold: null });
    const crew = store.getCrew(member.crewId);
    if (!crew || crew.status === "stopped") {
      return set({ status: "on_hold", hold: "crew-stopped", reason: "the recipient's crew is stopped; delivered after the next apply" });
    }
    // An apply is unarchiving and re-binding right now (seen live in a restore:
    // a background pass found the thread still archived and failed the message).
    if (crew.status === "starting") {
      return set({ status: "on_hold", hold: "crew-stopped", reason: "the recipient's crew is starting; delivered when apply is done" });
    }
    // §3.9.4 "Handover ohne Funkstille": held, then delivered to the new thread (the binding is read after the hold).
    const handover = store.activeHandover(member.id);
    if (handover && !message.forced) {
      return set({
        status: "on_hold",
        hold: "handover",
        reason: `${member.key} is handing over (shift ${handover.oldShift} → ${handover.oldShift + 1}); delivered to the new thread`,
      });
    }
    const binding = store.currentBinding(member.id);
    if (!binding) return set({ status: "failed", reason: "the recipient has no thread (run bb crew apply)", hold: null });
    const thread = await port.get(binding.threadId);
    if (!thread) return set({ status: "failed", reason: `the recipient's thread ${binding.threadId} is gone`, hold: null });
    if (thread.archived) return set({ status: "failed", reason: `the recipient's thread ${thread.id} is archived`, hold: null });
    if (!message.forced) {
      const open = await port.openInteractions(thread.id);
      if (open.length > 0) {
        return set({ status: "on_hold", hold: "interaction", reason: `waiting for an open ${open[0]!.kind}: ${open[0]!.title}`.slice(0, 300) });
      }
    }
    const threadBusy = BUSY_STATUSES.has(thread.status);
    store.markBusy(member.id, threadBusy, now());
    const busy = threadBusy || touched.has(thread.id);

    // Cross-crew message to a busy lead with a deputy: hold it, and hand it to
    // the deputy once the lead has been busy for longer than leadBusyTimeout.
    if (!message.forced && message.kind === "message" && member.lead && threadBusy && isCrossCrew(message)) {
      const deputy = deputyOf(crew, member);
      if (deputy) {
        const minutes = models(crew).spec?.leadBusyTimeout ?? 10;
        const since = store.busySince(member.id) ?? now();
        if (now() - since >= minutes * 60_000) {
          const rerouted = store.rerouteMessage(message.id, deputy, `deputy ${deputy.key} answers: ${member.key} busy for more than ${minutes} min`);
          return deliverOne(rerouted, touched, budget);
        }
        return set({ status: "on_hold", hold: "lead-busy", reason: `lead busy; deputy ${deputy.key} answers after ${minutes} min` });
      }
    }

    let mode: DeliveryMode;
    if (message.kind === "system") mode = busy ? "queue-if-active" : "ui";
    else if (message.priority === "urgent") mode = "steer-if-active";
    else mode = busy ? "queue-if-active" : "start";

    // System notices never start a turn (§3.4): an idle recipient sees them in the UI only.
    if (mode === "ui") return set({ status: "delivered", delivered: true, deliveryMode: "ui", hold: null });
    // Starting a turn needs a free thread slot (§3.9.5). Queueing behind a
    // running turn does not. Released messages go anyway.
    const startsTurn = !busy;
    if (startsTurn && !message.forced && budget && budget.limit !== null && budget.running >= budget.limit) {
      return set({ status: "throttled", hold: null, reason: `thread limit ${budget.limit} reached (${budget.running} running); delivered when a slot frees` });
    }
    // A previous attempt may have reached BB before the process died.
    if (message.attempts > 0 && (await port.hasMarker(thread.id, `msg ${message.id}`).catch(() => false))) {
      return set({ status: "delivered", delivered: true, deliveryMode: mode, hold: null, reason: "found in the thread after an interrupted attempt" });
    }
    store.updateMessage(message.id, { attempt: true, deliveryMode: mode });
    try {
      const result = await port.send(thread.id, renderMessage(message, maxStepsFor(message)), mode as SendMode);
      touched.add(thread.id);
      if (startsTurn && budget) budget.running += 1;
      return store.updateMessage(message.id, {
        status: result === "queued" ? "queued" : "delivered",
        delivered: true,
        hold: null,
        // Keep reasons the human should still see after delivery: a release, a deputy takeover.
        reason: message.forced || message.reason?.startsWith("deputy ") ? message.reason : null,
        lastError: null,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const attempts = message.attempts + 1;
      return store.updateMessage(message.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        lastError: text.slice(0, 500),
        reason: attempts >= MAX_ATTEMPTS ? `gave up after ${attempts} attempts` : message.reason,
      });
    }
  }

  let running: Promise<number> | null = null;
  let again = false;

  /** Work through every deliverable row once. Single-flight: a call during a drain schedules one more pass. */
  function drain(): Promise<number> {
    if (running) {
      again = true;
      return running;
    }
    const pass = (async () => {
      let changed = 0;
      do {
        again = false;
        const touched = new Set<string>();
        const messages = store.deliverable();
        const budget = messages.length > 0 && deps.capacity ? await deps.capacity().catch(() => null) : null;
        for (const message of messages) {
          const after = await deliverOne(message, touched, budget);
          if (after !== message && (after.status !== message.status || after.reason !== message.reason)) changed += 1;
        }
      } while (again);
      return changed;
    })();
    // Cleared after assignment: a pass with nothing to do settles synchronously.
    running = pass.finally(() => {
      running = null;
    });
    return running;
  }

  function requireMessage(id: string): MessageRow {
    const message = store.getMessage(id);
    if (!message) throw new AddressError(`There is no message "${id}".`);
    return message;
  }

  return {
    send,
    drain,
    deliverOne: (message: MessageRow, budget: Capacity | null = null) => deliverOne(message, new Set(), budget),
    parseAddress,
    /** Human: deliver a held or stopped message anyway (skips the interaction hold and the chain stop). */
    release(id: string): MessageRow {
      const message = requireMessage(id);
      if (!["on_hold", "stopped_loop", "throttled"].includes(message.status)) {
        throw new AddressError(`Message ${id} is ${message.status}; only held or stopped messages can be released.`);
      }
      return store.updateMessage(id, { status: "pending", forced: true, hold: null, reason: "released by the human", answeredAt: now() });
    },
    /** Human: drop a message that has not reached the thread. */
    discard(id: string): MessageRow {
      const message = requireMessage(id);
      if (!["pending", "on_hold", "stopped_loop", "throttled"].includes(message.status)) {
        throw new AddressError(`Message ${id} is ${message.status}; it can no longer be discarded.`);
      }
      return store.updateMessage(id, { status: "failed", hold: null, reason: "discarded by the human", answeredAt: now() });
    },
    /** Human: nothing more on this chain is delivered. Rows already given to BB stay as they are. */
    stopChain(chainId: string): MessageRow[] {
      store.stopChain(chainId, "stopped by the human");
      const open = store.listMessages({ chainId, limit: 1000 }).filter((m) => m.status === "pending" || m.status === "on_hold" || m.status === "stopped_loop");
      // Acknowledged at once: the human stopped it, so it does not ask for them again.
      return open.map((m) => store.updateMessage(m.id, { status: "stopped_loop", hold: null, reason: "chain stopped by the human", answeredAt: now() }));
    },
  };
}

/** Rules for the kickoff brief and the configure instructions. */
export function messagingRules(member: Pick<ResolvedMember, "address" | "lead">, policy: CrewPolicy): string {
  const crossCrew =
    policy.crossCrew === "open"
      ? "Members of other crews in this project are reachable as member@crew."
      : policy.crossCrew === "none"
        ? "This crew does not message other crews."
        : member.lead
          ? "Across crews only leads talk: you may write to other crews' leads (lead-key@crew)."
          : "Across crews only leads talk: send anything for another crew through your lead.";
  return [
    "Messaging (crew tools):",
    `- Your address is ${member.address}. Incoming messages start with "[crew] From: … → To: …" and carry msg id, chain id and step.`,
    '- Reply with crew_send(to: <sender from the header>, reply_to: <msg id>, subject, body). In your own crew the part after "@" can be dropped.',
    "- Addresses: a member (dev-impl), member@crew, @group:<id>, @crew (crew_broadcast), human.",
    '- Status reports to the human: crew_send(to: "human", kind: "info", …) — shown to the human, nobody waits for an answer.',
    '- Ask the human only when you need an answer: crew_send(to: "human", kind: "question", …). Keep one question open; more text is appended to it. The answer arrives as a message.',
    policy.messaging === "links" ? "- messaging: links — you may write only to linked members and the lead." : "",
    `- ${crossCrew}`,
    `- A chain stops at step ${policy.maxSteps}. Do not send acknowledgements or thanks; reply only when there is work to hand over.`,
    "- crew_whoami: your role and instructions. crew_peers: the team. crew_inbox: recent messages to you.",
  ]
    .filter(Boolean)
    .join("\n");
}
