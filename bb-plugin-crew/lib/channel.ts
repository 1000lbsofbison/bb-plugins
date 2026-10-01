// Channel (§3.5): a crew-wide feed that wakes nobody. Only an explicit
// `@member` mention becomes a message, and that message goes through the
// normal delivery path — routing rules, header and loop protection included.
import { randomBytes } from "node:crypto";
import { AddressError, type Delivery, type Sender } from "./delivery";
import type { ChannelRow, CrewRow, MessageRow, Store } from "./store";

export type Channel = ReturnType<typeof createChannel>;

/** Member keys mentioned as `@key` that exist in the crew, in order, without duplicates. */
export function mentionsIn(body: string, keys: readonly string[]): string[] {
  const known = new Set(keys);
  const found: string[] = [];
  for (const match of body.matchAll(/(^|[\s(,;])@([A-Za-z0-9][\w-]*)/g)) {
    const key = match[2]!;
    if (known.has(key) && !found.includes(key)) found.push(key);
  }
  return found;
}

export function createChannel(deps: { store: Store; delivery: Delivery; newId?: () => string }) {
  const { store, delivery } = deps;
  const newId = deps.newId ?? (() => `cm_${randomBytes(5).toString("hex")}`);

  return {
    /** Post to the channel; mentions are sent as messages and returned alongside. */
    post(crew: CrewRow, from: Extract<Sender, { kind: "human" | "member" }>, body: string, topic: string | null = null): { post: ChannelRow; mentions: MessageRow[] } {
      const text = body.trim();
      if (!text) throw new AddressError("The post is empty.");
      if (from.kind === "member" && from.crew.id !== crew.id) throw new AddressError("You can only post to your own crew's channel.");
      const post = store.insertChannel({
        id: newId(),
        crewId: crew.id,
        author: from.kind === "human" ? "human" : from.member.address,
        topic: topic?.trim() || null,
        body: text.slice(0, 20_000),
      });
      const self = from.kind === "member" ? from.member.key : null;
      const keys = store.listMembers(crew.id).map((member) => member.key).filter((key) => key !== self);
      const mentions: MessageRow[] = [];
      for (const key of mentionsIn(text, keys)) {
        mentions.push(
          ...delivery.send({
            projectId: crew.projectId,
            from,
            to: `${key}@${crew.name}`,
            subject: `Channel${post.topic ? ` [${post.topic}]` : ""}: ${text.split("\n")[0]!.slice(0, 80)}`,
            body: `You were mentioned in the crew channel (post ${post.id}):\n${text}`,
            crew: crew.name,
          }),
        );
      }
      return { post, mentions };
    },
    read(crew: CrewRow, options: { since?: number; topic?: string; limit?: number } = {}): ChannelRow[] {
      return store.listChannel(crew.id, options);
    },
  };
}

export function formatChannelLine(row: ChannelRow): string {
  return `${new Date(row.createdAt).toISOString().slice(0, 16)}Z ${row.id} ${row.author}${row.topic ? ` [${row.topic}]` : ""}: ${row.body.replace(/\s+/g, " ").slice(0, 400)}`;
}
