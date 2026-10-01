// RPC contract for other plugins (§4.8), e.g. Graph Studio's `member` node
// (E5). Every answer carries `contractVersion`, so a caller can refuse a
// contract it does not know instead of misreading it.
//
// - sendToMember is idempotent per correlationId: the first call writes the
//   message and remembers its id (`rpc_sends`, PRIMARY KEY); every later call
//   with the same id returns that message and writes nothing.
// - memberReply reads the first completed assistant answer after delivery
//   from the thread the message went to (lib/reply.ts), across shifts.
import type { ActivityTracker } from "./activity";
import { AddressError, type Delivery } from "./delivery";
import type { CrewModels } from "./policy";
import type { Store } from "./store";
import type { ThreadPort } from "./thread-port";

export const CONTRACT_VERSION = 1;

export type MemberInfo = {
  memberId: string;
  address: string;
  crew: string;
  key: string;
  lead: boolean;
  role: string;
  threadId: string | null;
  shift: number | null;
  activity: string;
};

export type ReplyStatus = "pending" | "held" | "running" | "completed" | "failed" | "refused";

export function createContract(deps: {
  store: Store;
  port: ThreadPort;
  delivery: Delivery;
  activity: ActivityTracker;
  models: CrewModels;
}) {
  const { store, port, delivery, activity } = deps;

  async function info(crewName: string, memberRow: string): Promise<MemberInfo | null> {
    const member = store.getMember(memberRow);
    if (!member || member.removedAt !== null) return null;
    const crew = store.getCrew(member.crewId)!;
    const binding = store.currentBinding(member.id);
    const view = (await activity.views(crew)).find((entry) => entry.memberRow === member.id);
    return {
      memberId: member.id,
      address: member.address,
      crew: crewName,
      key: member.key,
      lead: member.lead,
      role: String(member.config.role ?? ""),
      threadId: binding?.threadId ?? null,
      shift: binding?.shift ?? null,
      activity: view?.activity ?? "unknown",
    };
  }

  /** `member@crew` in the project. A bare key works when it is unique across the project's crews. */
  function find(projectId: string, address: string) {
    const target = delivery.parseAddress(address);
    if (target.kind !== "member") throw new AddressError(`"${address}" is not a member address (member@crew).`);
    const crews = target.crew ? [store.findCrew(projectId, target.crew)].filter((crew) => crew !== null) : store.listCrews(projectId);
    const matches = crews.flatMap((crew) => store.listMembers(crew.id).filter((member) => member.key === target.key).map((member) => ({ crew, member })));
    if (matches.length === 0) throw new AddressError(`No member "${address}" in this project.`);
    if (matches.length > 1) throw new AddressError(`"${address}" exists in several crews; write member@crew.`);
    return matches[0]!;
  }

  async function sendToMember(input: { projectId: string; address: string; body: string; from: string; subject?: string; correlationId: string }) {
    const known = store.rpcSend(input.correlationId);
    if (known) {
      const row = store.getMessage(known);
      return { contractVersion: CONTRACT_VERSION, messageId: known, status: row?.status ?? "failed", duplicate: true, error: null };
    }
    try {
      const { crew, member } = find(input.projectId, input.address);
      const [row] = delivery.send({
        projectId: input.projectId,
        from: { kind: "plugin", name: input.from },
        to: member.address,
        body: input.body,
        subject: input.subject,
        crew: crew.name,
      });
      store.recordRpcSend(input.correlationId, row!.id);
      await delivery.drain();
      const after = store.getMessage(row!.id)!;
      return { contractVersion: CONTRACT_VERSION, messageId: after.id, status: after.status, duplicate: false, error: null };
    } catch (error) {
      if (error instanceof AddressError) return { contractVersion: CONTRACT_VERSION, messageId: null, status: "rejected" as const, duplicate: false, error: error.message };
      throw error;
    }
  }

  async function memberReply(messageId: string): Promise<{ contractVersion: number; status: ReplyStatus; text: string | null; eventCursor: number | null; threadId: string | null }> {
    const none = { contractVersion: CONTRACT_VERSION, text: null, eventCursor: null, threadId: null };
    const message = store.getMessage(messageId);
    if (!message) return { ...none, status: "refused", text: `There is no message "${messageId}".` };
    if (message.status === "pending" || message.status === "throttled") return { ...none, status: "pending" };
    if (message.status === "on_hold") return { ...none, status: "held", text: message.reason };
    if (message.status !== "delivered" && message.status !== "queued") return { ...none, status: "refused", text: message.reason ?? message.status };
    if (!message.toMember) return { ...none, status: "refused", text: "the message has no member recipient" };
    // Newest shift first: after a handover the answer may come from either thread.
    const threads = store.listBindings(message.toMember).map((binding) => binding.threadId).reverse();
    const unreadable: string[] = [];
    for (const threadId of [...new Set(threads)]) {
      const reply = await port.reply(threadId, `msg ${message.id}`).catch((error: unknown) => {
        unreadable.push(`${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (!reply || reply.state === "waiting") continue;
      const status: ReplyStatus = reply.state;
      return { contractVersion: CONTRACT_VERSION, status, text: reply.text, eventCursor: reply.cursor, threadId };
    }
    // Say why nothing was found when a thread's log could not be read, rather than looking like a slow member.
    return { ...none, status: message.status === "queued" ? "pending" : "running", text: unreadable.length ? `events unreadable: ${unreadable.join("; ")}`.slice(0, 500) : null };
  }

  return {
    async resolveMember(projectId: string, address: string) {
      try {
        const { crew, member } = find(projectId, address);
        return { contractVersion: CONTRACT_VERSION, member: await info(crew.name, member.id), error: null };
      } catch (error) {
        if (error instanceof AddressError) return { contractVersion: CONTRACT_VERSION, member: null, error: error.message };
        throw error;
      }
    },
    async listMembers(projectId: string, crewName?: string) {
      const crews = crewName ? [store.findCrew(projectId, crewName)].filter((crew) => crew !== null) : store.listCrews(projectId);
      const members: MemberInfo[] = [];
      for (const crew of crews) for (const member of store.listMembers(crew.id)) {
        const entry = await info(crew.name, member.id);
        if (entry) members.push(entry);
      }
      return { contractVersion: CONTRACT_VERSION, members };
    },
    sendToMember,
    memberReply,
  };
}

export type Contract = ReturnType<typeof createContract>;
