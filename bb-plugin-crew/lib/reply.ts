// The reply to a delivered message (§4.8 `memberReply`): the first completed
// assistant answer after the message reached the thread.
//
// BB has no "reply to message X" relation, so it is read from the thread's
// event log (seen live on claude-code, 30.09.2026): the delivery shows up as a
// `client/turn/requested` whose input text carries the header marker
// `msg <id>`; BB answers with `turn/input/accepted` naming that request id,
// the turn's assistant text arrives as `item/completed` items of type
// `agentMessage`, and the turn ends with `turn/completed` (`status`). A message
// queued behind a running turn gets its own request once BB dispatches it.
// Pure, so the fake port and the SDK port share it.

export type ReplyEvent = { seq: number; type: string; data: unknown };

export type TurnReply =
  /** The marker is not in the log yet (queued, or not dispatched). */
  | { state: "waiting"; text: null; cursor: number | null }
  | { state: "running"; text: string | null; cursor: number }
  | { state: "completed"; text: string | null; cursor: number }
  | { state: "failed"; text: string | null; cursor: number };

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose => (typeof value === "object" && value !== null ? (value as Loose) : {});

function inputText(data: Loose): string {
  const input = Array.isArray(data.input) ? data.input : [];
  return input.map((part) => String(record(part).text ?? "")).join("\n");
}

export function replyFromEvents(events: readonly ReplyEvent[], marker: string): TurnReply {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const request = ordered.find((event) => event.type === "client/turn/requested" && inputText(record(event.data)).includes(marker));
  if (!request) return { state: "waiting", text: null, cursor: null };
  const requestId = record(request.data).requestId;
  let accepted = false;
  let text: string | null = null;
  let cursor = request.seq;
  for (const event of ordered) {
    if (event.seq <= request.seq) continue;
    const data = record(event.data);
    if (!accepted) {
      // Without a request id (older logs) the next accepted turn is the one.
      if (event.type === "turn/input/accepted" && (requestId === undefined || data.clientRequestId === requestId)) {
        accepted = true;
        cursor = event.seq;
      }
      continue;
    }
    cursor = event.seq;
    if (event.type === "item/completed") {
      const item = record(data.item);
      if (item.type === "agentMessage" && typeof item.text === "string") text = item.text;
    } else if (event.type === "turn/completed") {
      return { state: data.status === "completed" ? "completed" : "failed", text, cursor };
    }
  }
  return { state: "running", text, cursor };
}
