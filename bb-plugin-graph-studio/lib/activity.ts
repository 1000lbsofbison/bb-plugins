// What a worker is doing right now, as one short line.
//
// A node spends its minutes inside `awaitThread`, and LangGraph has nothing to
// say in that time: it emits one event per node, and that event is "finished".
// The activity therefore cannot come from the graph — it comes from the BB
// thread underneath, whose timeline items are the same ones the user would see
// by opening the worker.
//
// Pure on purpose: the SDK call lives in the server, the interpretation lives
// here, so every branch below is testable without a host.

/** The event types worth asking for. Anything else is noise on a canvas. */
export const ACTIVITY_EVENT_TYPES = ["item/started", "item/completed"] as const;

/** A node label is 172px wide; past this the line is a rectangle of ellipsis. */
const MAX_LENGTH = 44;

function clamp(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat === "") return "";
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH - 1)}…` : flat;
}

/** The last path segment: "lib/graph.ts" says more in 12 chars than the root. */
function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.slice(-2).join("/") || path;
}

type Presentation = {
  label?: { pending?: unknown; completed?: unknown };
  title?: unknown;
  detail?: unknown;
  suppress?: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * BB's own wording for the item, if the provider supplied one. Preferred over
 * anything assembled here: it is the line the user already reads in the
 * thread, so the canvas and the thread say the same thing about the same
 * moment instead of two descriptions that drift apart.
 */
function fromPresentation(item: Record<string, unknown>): string | null {
  const presentation = item.presentation as Presentation | undefined;
  if (!presentation) return null;
  // An item without a `status` has not reported one — `reasoning` and
  // `agentMessage` never do. Treated as pending, because these arrive on
  // `item/started` and the present tense is the one the canvas is in.
  const pending = item.status !== "completed";
  const label = pending
    ? asString(presentation.label?.pending) ??
      asString(presentation.label?.completed)
    : asString(presentation.label?.completed) ??
      asString(presentation.label?.pending);
  // `title` carries the specific part — the command, the file name — and
  // `label` only the verb. Measured against real events: without the title,
  // every shell call on the canvas reads "Running command" and the line says
  // nothing that distinguishes one minute from the next. `detail` is the same
  // role under another name, so whichever is present is used.
  const subject = asString(presentation.title) ?? asString(presentation.detail);
  const head = label ?? subject;
  if (!head) return null;
  return head === subject || subject === null ? head : `${head}: ${subject}`;
}

/** Our own wording, for the items that arrive without a presentation. */
function fromKind(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "toolCall": {
      const tool = asString(item.tool);
      if (!tool) return null;
      const server = asString(item.server);
      return server ? `${server} · ${tool}` : tool;
    }
    case "fileRead": {
      const path = asString(item.path);
      return path ? `Reading ${basename(path)}` : "Reading a file";
    }
    case "search": {
      const query = asString(item.query);
      return query ? `Searching ${query}` : "Searching";
    }
    case "reasoning":
      return "Thinking";
    case "plan":
    case "planSteps":
      return "Planning";
    case "contextCompaction":
      return "Compacting context";
    case "backgroundTask":
      return asString(item.taskType) ?? "Background task";
    // Neither of these carries a presentation in practice, and both are what a
    // worker does most of the time — leaving them out would mean the canvas
    // stays blank through the longest stretches of a node.
    case "agentMessage": {
      const text = asString(item.text);
      return text ? `Writing: ${text}` : "Writing";
    }
    case "commandExecution":
      return asString(item.cmd) ?? "Running a command";
    case "fileChange": {
      const path = asString(item.path);
      return path ? `Editing ${basename(path)}` : "Editing a file";
    }
    case "delegation":
      return asString(item.label) ?? "Delegating";
    default:
      return null;
  }
}

/**
 * The activity line for one thread event, or null when the event says nothing
 * a reader could act on. Null rather than a placeholder: a canvas that shows
 * "working…" under every node has added a row and no information, and the
 * previous line — which did say something — would have been overwritten by it.
 *
 * Takes the event's `data` as it comes off the SDK, unparsed: the union of
 * item shapes is large and mostly irrelevant here, and a schema for it would
 * have to be kept in step with BB's timeline for no gain.
 */
export function describeActivity(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const item = (data as { item?: unknown }).item;
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  // BB hides suppressed items from its own timeline. Checked before both
  // readings, not inside the presentation one: falling through to the kind
  // fallback would put the item back on the canvas under another name.
  if ((record.presentation as { suppress?: unknown } | undefined)?.suppress === true) {
    return null;
  }
  const text = fromPresentation(record) ?? fromKind(record);
  if (!text) return null;
  const clamped = clamp(text);
  return clamped === "" ? null : clamped;
}

/**
 * Elapsed time as "4:12" — minutes and seconds, hours only once there are
 * any. A node that has run for six minutes is the thing the reader is judging;
 * "6:41" answers it at a glance where a timestamp would have to be subtracted.
 */
export function elapsedLabel(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

/**
 * Signs of life per node id: since when its current attempt has been running,
 * and what its worker is doing.
 *
 * Keyed by node rather than by attempt because that is what the canvas draws.
 * Where a node runs fanned out it has several attempts at once and only one
 * box; the most recently started branch speaks for it, which is also the one
 * whose activity is the freshest.
 */
export function activityByNode(
  nodeRuns: ReadonlyArray<{
    nodeId: string;
    status: string;
    startedAt: number | null;
    activity: string | null;
  }>,
): Record<string, { startedAt: number | null; text: string | null }> {
  const out: Record<string, { startedAt: number | null; text: string | null }> = {};
  for (const nodeRun of nodeRuns) {
    // Only running attempts: a finished one's start time would run a clock for
    // a node that stopped, and its last line would read as the present tense.
    if (nodeRun.status !== "running") continue;
    const seen = out[nodeRun.nodeId];
    if (seen && (seen.startedAt ?? 0) >= (nodeRun.startedAt ?? 0)) continue;
    out[nodeRun.nodeId] = {
      startedAt: nodeRun.startedAt,
      text: nodeRun.activity,
    };
  }
  return out;
}

/**
 * How long each finished node ran, as the label `elapsedLabel` would have
 * shown at its end. Where a node ran more than once — a loop, a fan-out — the
 * most recently started attempt speaks for it, as in `activityByNode`.
 */
export function durationByNode(
  nodeRuns: ReadonlyArray<{
    nodeId: string;
    status: string;
    startedAt: number | null;
    endedAt: number | null;
  }>,
): Record<string, string> {
  const latest: Record<string, { startedAt: number; endedAt: number }> = {};
  for (const nodeRun of nodeRuns) {
    if (nodeRun.status !== "done" && nodeRun.status !== "failed") continue;
    if (nodeRun.startedAt === null || nodeRun.endedAt === null) continue;
    const seen = latest[nodeRun.nodeId];
    if (seen && seen.startedAt >= nodeRun.startedAt) continue;
    latest[nodeRun.nodeId] = { startedAt: nodeRun.startedAt, endedAt: nodeRun.endedAt };
  }
  const out: Record<string, string> = {};
  for (const [nodeId, span] of Object.entries(latest)) {
    out[nodeId] = elapsedLabel(span.startedAt, span.endedAt);
  }
  return out;
}
