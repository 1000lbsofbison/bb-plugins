// The only place that calls `bb.sdk.threads.*` (§4.2). Everything above it
// talks to the `ThreadPort` interface, so tests swap in `createFakeThreadPort`
// and the SDK's quirks (workspace_busy, missing model field, 404 on deleted
// threads) are handled in exactly one file.
//
// SDK 0.5.29 limitations that shape this file (bundled-types/bb-plugin-sdk.d.ts):
// - `managed-worktree` takes only a `baseBranch` (`named` | `default`,
//   d.ts:11981–11987); the new worktree's own branch name is chosen by BB.
//   The `crew/<crew>` and `crew/<crew>/<member>` branch names from §3.2
//   cannot be requested. `unmanaged` accepts `branch: existing | new` but
//   `new` has no name either (d.ts:11971–11979).
// - `permissionMode` knows only `accept-edits | auto | full` (d.ts:12123–12127).
//   There is no read-only mode, so `ask` maps to `accept-edits`, BB's
//   standard mode in which escalations are asked for.
// - `ThreadResponse` carries `providerId` but no model (d.ts:13539–13591);
//   the model is read from `threads.defaultExecutionOptions`
//   (`ResolvedThreadExecutionOptions.model`, d.ts:3993–4021).
// - `ThreadListResponse` rows carry no plugin metadata (d.ts:13263–13336),
//   so finding a thread by `opId` needs one `getPluginMetadata` per candidate.
// - `threads.send` answers `delivery: "sent" | "queued"` (d.ts:12540–12546);
//   `queued` means BB holds the message in the thread's queue and will run
//   it, so it counts as delivered and is never sent again (§3.4).
// - There is no `interaction.resolved` event, only `interaction.pending`
//   (d.ts:20627). Whether a hold can be released is read from
//   `threads.interactions.list` (d.ts:16723–16729), whose rows carry
//   `status: pending | resolving | resolved | interrupted`.
// - Read status: `ThreadResponse.lastReadAt` and `latestAttentionAt`
//   (d.ts:13548–13549) — "Unread result" is `latestAttentionAt > lastReadAt`.
// - E3: the branch BB chose for a worktree is read from `environments.get`
//   (`Environment.branchName`, `path`, `defaultBranch`, d.ts:417–470).
//   Context usage comes from `threads.context` (`usage.usedTokens` and
//   `usage.modelContextWindow`, d.ts:4397–4430 and :16820); `usage` is null
//   until the provider reported a turn. Running threads are counted with
//   `threads.count({ status: "active" }).total` (d.ts:16421–16429, :14321–14327). The SDK has no
//   read access to BB's concurrency limit (no field in d.ts; the limit lives
//   behind the `bb concurrency-limit` CLI), see lib/capacity.ts.
// - E4: metadata is merged with `threads.updatePluginMetadata({set, remove})`
//   (d.ts:16551–16557, :16776); a new shift without a new thread uses
//   `threads.clearContext` (d.ts:16765). `threads.open` takes `split:
//   down | left | replace | right | top` (d.ts:14236–14243, :16643–16647) and
//   reaches every connected client. There is no way to append a message to a
//   transcript without dispatching it: `send` knows only `auto | start | steer
//   | queue-if-active | steer-if-active` (d.ts:12500–12506).
// - `threads.events.list` takes `limit` as a string (d.ts:16650–16658) but
//   refuses anything above 100 with HTTP 400 — found live in E4; the E2
//   marker check asked for 200 and failed silently until then.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { replyFromEvents, type ReplyEvent, type TurnReply } from "./reply";
import type { Permission } from "./spec";

export const PLUGIN_ID = "crew";
/** BB refuses more: "HTTP 400: Thread event limit cannot exceed 100" (seen live, 30.09.2026; the d.ts types `limit` as a plain string). */
export const EVENT_PAGE = 100;

export type ThreadInfo = {
  id: string;
  projectId: string;
  providerId: string;
  parentThreadId: string | null;
  title: string | null;
  status: string;
  archived: boolean;
  environmentId: string | null;
  /** When the human last opened the thread; null = never. */
  lastReadAt: number | null;
  /** When the thread last produced something that wants attention (a finished turn). */
  latestAttentionAt: number;
};

export type OpenInteraction = { id: string; kind: string; title: string };
export type SendMode = "start" | "queue-if-active" | "steer-if-active";

export type PortEnvironment =
  | { kind: "managed-worktree" }
  | { kind: "project-default" }
  | { kind: "reuse"; environmentId: string }
  | { kind: "host"; hostId: string };

export type CrewMetadata = {
  crew: string;
  crewId: string;
  member: string;
  address: string;
  shift: number;
  opId: string;
  lead: boolean;
};

export type SpawnRequest = {
  projectId: string;
  prompt: string;
  title: string;
  providerId: string;
  model: string;
  reasoningLevel?: string | null;
  serviceTier?: string | null;
  permissions: Permission;
  parentThreadId: string | null;
  environment: PortEnvironment;
  metadata: CrewMetadata;
};

/** `hostId`: the machine the environment lives on; null/absent when BB does not say. */
export type EnvironmentInfo = { path: string | null; branch: string | null; defaultBranch: string | null; hostId?: string | null };
export type ContextUsage = { usedTokens: number; contextWindow: number };

export type ThreadPatch = { title?: string; parentThreadId?: string; model?: string };
export type OpenSplit = "down" | "left" | "replace" | "right" | "top";

export interface ThreadPort {
  spawn(request: SpawnRequest): Promise<ThreadInfo>;
  /** `null` when the thread is gone (deleted or never existed). */
  get(threadId: string): Promise<ThreadInfo | null>;
  /** The model BB resolved for the thread, `null` when BB does not say. */
  model(threadId: string): Promise<string | null>;
  /** Wait until the thread has an environment, e.g. a worktree still provisioning. */
  environmentOf(threadId: string): Promise<string | null>;
  /** Every thread this plugin spawned in the project, hidden and archived included. */
  listOwn(projectId: string): Promise<ThreadInfo[]>;
  metadata(threadId: string): Promise<Record<string, unknown>>;
  update(threadId: string, patch: ThreadPatch): Promise<void>;
  archive(threadId: string): Promise<void>;
  /**
   * Delete one thread. BB does not delete sub-threads with it, so callers
   * delete `children` first; a thread that is already gone is not an error.
   */
  delete(threadId: string): Promise<void>;
  /** Direct child threads, archived ones included, deleted ones not. */
  children(threadId: string): Promise<string[]>;
  unarchive(threadId: string): Promise<void>;
  stop(threadId: string): Promise<void>;
  /** `sent`: a turn runs (or was steered); `queued`: BB queued it behind the running turn. */
  send(threadId: string, text: string, mode: SendMode): Promise<"sent" | "queued">;
  /** Interactions still waiting for the human (pending or resolving). */
  openInteractions(threadId: string): Promise<OpenInteraction[]>;
  /** Did a text containing `marker` already reach the thread (events or queue)? Dedupe after a crash mid-send. */
  hasMarker(threadId: string, marker: string): Promise<boolean>;
  /** Path and branch of an environment; null when BB does not know it. */
  environmentInfo(environmentId: string): Promise<EnvironmentInfo | null>;
  /** Host of the BB server's own machine (`system.config().primaryHostId`); null when BB does not say. */
  localHostId(): Promise<string | null>;
  /** Host of the project's default source — where a managed worktree is created. */
  projectHostId(projectId: string): Promise<string | null>;
  /** Context window usage of the thread's session; null until the provider reported one. */
  contextUsage(threadId: string): Promise<ContextUsage | null>;
  /** Threads running right now across BB (status active). */
  runningCount(): Promise<number>;
  /** Merge keys into the thread's `crew` metadata namespace; `remove` drops keys. */
  setMetadata(threadId: string, set: Record<string, unknown>, remove?: string[]): Promise<void>;
  /** Clear the model context: the same thread starts over with an empty session. */
  clearContext(threadId: string): Promise<void>;
  /** Every live (not archived, not deleted) thread of the project, whoever made it. */
  listProject(projectId: string): Promise<ThreadInfo[]>;
  /** Open a thread in the connected BB apps. */
  open(threadId: string, split: OpenSplit): Promise<void>;
  /** The first answer after the text carrying `marker` reached the thread. */
  reply(threadId: string, marker: string): Promise<TurnReply>;
}

export function permissionModeFor(permissions: Permission): "accept-edits" | "auto" | "full" {
  return permissions === "ask" ? "accept-edits" : permissions;
}

/** BB's error for "someone else still holds this workspace" (409). */
export function isWorkspaceBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 && candidate.code === "workspace_busy";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}

export type BackoffOptions = {
  timeoutMs?: number;
  delayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (attempt: number, waitedMs: number) => void;
};

/**
 * Retry only while BB reports the workspace as busy. Safe because the refusal
 * happens before a thread exists. Pattern from graph-studio `lib/workspace.ts`.
 */
export async function whileWorkspaceBusy<T>(attempt: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let delay = options.delayMs ?? 250;
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isWorkspaceBusy(error)) throw error;
      const waited = now() - startedAt;
      if (waited + delay > timeoutMs) throw error;
      options.onWait?.(tries, waited);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

type SdkThread = {
  id: string;
  projectId: string;
  providerId: string;
  parentThreadId: string | null;
  title: string | null;
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
  environmentId: string | null;
  lastReadAt?: number | null;
  latestAttentionAt?: number;
};

function toInfo(thread: SdkThread): ThreadInfo {
  return {
    id: thread.id,
    projectId: thread.projectId,
    providerId: thread.providerId,
    parentThreadId: thread.parentThreadId,
    title: thread.title,
    status: thread.status,
    archived: thread.archivedAt !== null,
    environmentId: thread.environmentId,
    lastReadAt: thread.lastReadAt ?? null,
    latestAttentionAt: thread.latestAttentionAt ?? 0,
  };
}

function sdkEnvironment(environment: PortEnvironment, defaultHostId: string | null) {
  switch (environment.kind) {
    case "reuse":
      return { type: "reuse" as const, environmentId: environment.environmentId };
    case "project-default":
      return { type: "project-default" as const };
    case "managed-worktree":
      // BB refuses a managed worktree without a host (HTTP 400 "hostId is
      // required unless workspace.type is personal"), so it is the host of
      // the project's default source.
      if (!defaultHostId) throw new Error("the project has no default source host for a worktree");
      return {
        type: "host" as const,
        hostId: defaultHostId,
        workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } },
      };
    case "host":
      return {
        type: "host" as const,
        hostId: environment.hostId,
        workspace: { type: "managed-worktree" as const, baseBranch: { kind: "default" as const } },
      };
  }
}

/**
 * A readable line for an interaction: plugin forms carry `title`, approvals a
 * `reason`, provider user questions a `questions[].prompt` (seen live on
 * claude-code, 30.09.2026).
 */
export function interactionTitle(payload: unknown): string {
  const value = (payload ?? {}) as { kind?: string; title?: unknown; reason?: unknown; questions?: { prompt?: unknown }[] };
  if (typeof value.title === "string" && value.title) return value.title;
  const prompts = (value.questions ?? []).map((question) => question.prompt).filter((prompt): prompt is string => typeof prompt === "string");
  if (prompts.length > 0) return prompts.join(" / ");
  if (typeof value.reason === "string" && value.reason) return value.reason;
  return value.kind ?? "interaction";
}

export function createSdkThreadPort(bb: BbPluginApi, options: { backoff?: BackoffOptions } = {}): ThreadPort {
  const threads = () => bb.sdk.threads;
  async function defaultHost(projectId: string): Promise<string | null> {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
    return source?.hostId ?? null;
  }
  return {
    async spawn(request) {
      const hostId = request.environment.kind === "managed-worktree" ? await defaultHost(request.projectId) : null;
      const environment = sdkEnvironment(request.environment, hostId);
      const thread = await whileWorkspaceBusy(
        () =>
          threads().spawn({
            projectId: request.projectId,
            prompt: request.prompt,
            title: request.title,
            visibility: "visible",
            providerId: request.providerId,
            model: request.model,
            permissionMode: permissionModeFor(request.permissions),
            // Without "explicit" BB treats the values as a client preference
            // and may silently pick the project default instead (§6).
            ...(request.reasoningLevel ? { reasoningLevel: request.reasoningLevel as never } : {}),
            ...(request.serviceTier ? { serviceTier: request.serviceTier as never } : {}),
            executionInputSources: {
              providerId: "explicit",
              model: "explicit",
              permissionMode: "explicit",
              ...(request.reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
              ...(request.serviceTier ? { serviceTier: "explicit" as const } : {}),
            },
            ...(request.parentThreadId ? { parentThreadId: request.parentThreadId } : {}),
            environment,
            pluginMetadata: request.metadata,
          }),
        {
          ...options.backoff,
          onWait: (attempt, waited) =>
            bb.log.info(`${request.title}: workspace busy, retrying (attempt ${attempt}, ${waited} ms)`),
        },
      );
      return toInfo(thread);
    },
    async get(threadId) {
      try {
        const thread = await threads().get({ threadId });
        if (thread.deletedAt !== null) return null;
        return toInfo(thread);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async model(threadId) {
      const resolved = await threads().defaultExecutionOptions({ threadId });
      return resolved?.model ?? null;
    },
    async environmentOf(threadId) {
      for (let i = 0; i < 120; i += 1) {
        const thread = await threads().get({ threadId });
        if (thread.environmentId) return thread.environmentId;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    },
    async listOwn(projectId) {
      const [active, archived] = await Promise.all(
        [false, true].map((isArchived) =>
          threads().list({ projectId, originPluginId: PLUGIN_ID, includeHidden: true, archived: isArchived, limit: 500 }),
        ),
      );
      const seen = new Map<string, ThreadInfo>();
      for (const row of [...active!, ...archived!]) {
        if (row.deletedAt !== null) continue;
        seen.set(row.id, toInfo({ ...row, environmentId: row.environmentId }));
      }
      return [...seen.values()];
    },
    async metadata(threadId) {
      return (await threads().getPluginMetadata({ threadId })) as Record<string, unknown>;
    },
    async update(threadId, patch) {
      await threads().update({ threadId, ...patch });
    },
    async archive(threadId) {
      await threads().archive({ threadId });
    },
    async delete(threadId) {
      try {
        // Children are deleted by the caller beforehand; the flag only confirms BB's prompt.
        await threads().delete({ threadId, childThreadsConfirmed: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async children(threadId) {
      const pages = await Promise.all(
        [false, true].map((isArchived) => threads().list({ parentThreadId: threadId, includeHidden: true, archived: isArchived, limit: 500 })),
      );
      return [...new Set(pages.flat().filter((row) => row.deletedAt === null).map((row) => row.id))];
    },
    async unarchive(threadId) {
      await threads().unarchive({ threadId });
    },
    async stop(threadId) {
      await threads().stop({ threadId });
    },
    async send(threadId, text, mode) {
      const result = await threads().send({ threadId, mode, input: [{ type: "text", text, mentions: [] }] });
      return result.delivery;
    },
    async openInteractions(threadId) {
      const rows = await threads().interactions.list({ threadId });
      return rows
        .filter((row) => row.status === "pending" || row.status === "resolving")
        .map((row) => ({ id: row.id, kind: (row.payload as { kind: string }).kind, title: interactionTitle(row.payload) }));
    },
    async hasMarker(threadId, marker) {
      const [events, queued] = await Promise.all([
        threads().events.list({ threadId, order: "desc", limit: String(EVENT_PAGE) }),
        threads().queuedMessages.list({ threadId }).catch(() => []),
      ]);
      return JSON.stringify(events).includes(marker) || JSON.stringify(queued).includes(marker);
    },
    async environmentInfo(environmentId) {
      try {
        const env = await bb.sdk.environments.get({ environmentId });
        return { path: env.path, branch: env.branchName, defaultBranch: env.defaultBranch, hostId: env.hostId ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async localHostId() {
      return (await bb.sdk.system.config()).primaryHostId ?? null;
    },
    async projectHostId(projectId) {
      return defaultHost(projectId);
    },
    async contextUsage(threadId) {
      const context = await threads().context({ threadId });
      const usage = context.usage;
      if (!usage || !(usage.modelContextWindow > 0)) return null;
      return { usedTokens: usage.usedTokens, contextWindow: usage.modelContextWindow };
    },
    async runningCount() {
      return (await threads().count({ status: "active" })).total;
    },
    async setMetadata(threadId, set, remove) {
      await threads().updatePluginMetadata({ threadId, set: set as never, ...(remove && remove.length ? { remove } : {}) });
    },
    async clearContext(threadId) {
      await threads().clearContext({ threadId });
    },
    async listProject(projectId) {
      const rows = await threads().list({ projectId, archived: false, limit: 500 });
      return rows.filter((row) => row.deletedAt === null).map((row) => toInfo({ ...row, environmentId: row.environmentId }));
    },
    async open(threadId, split) {
      await threads().open({ threadId, split, file: null });
    },
    async reply(threadId, marker) {
      // Newest first, a page of EVENT_PAGE at a time, until the page holding
      // the marked request: the answer can only come after it. Bounded, so a
      // huge thread cannot stall a caller.
      const events: ReplyEvent[] = [];
      let before: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const rows = await threads().events.list({ threadId, order: "desc", limit: String(EVENT_PAGE), ...(before ? { beforeSeq: before } : {}) });
        for (const row of rows) events.push({ seq: row.seq, type: row.type, data: row.data });
        const found = rows.some((row) => row.type === "client/turn/requested" && JSON.stringify(row.data).includes(marker));
        if (found || rows.length < EVENT_PAGE) break;
        before = String(rows[rows.length - 1]!.seq);
      }
      return replyFromEvents(events, marker);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake for tests: in-memory threads with the same observable behaviour.

export type FakeThread = ThreadInfo & {
  model: string;
  metadata: Record<string, unknown>;
  request?: SpawnRequest;
  /** Everything sent to the thread, with the mode used. */
  inbox: { text: string; mode: SendMode }[];
  interactions: OpenInteraction[];
  /** Event log the fake answers `reply` from; tests append turns to it. */
  events: ReplyEvent[];
};

export type FakeThreadPort = ThreadPort & {
  threads: Map<string, FakeThread>;
  calls: { method: string; args: unknown }[];
  /** Makes the next spawns fail with this error (one entry per spawn). */
  spawnFailures: unknown[];
  /** Pretend BB resolved a different model than requested. */
  modelOverride: Map<string, string>;
  /** Makes the next sends fail with this error (one entry per send). */
  sendFailures: unknown[];
  countCalls(method: string): number;
  /** environmentId → info; unset ones answer `/work/<env>` on branch `bb/<env>`. */
  environments: Map<string, EnvironmentInfo>;
  /** Host the fake BB server runs on; environments default to it. */
  localHost: string | null;
  /** Host of the project's default source and of every environment not in `environments`; defaults to `localHost`. */
  projectHost: string | null | undefined;
  /** threadId → context usage. */
  usage: Map<string, ContextUsage>;
  /** Threads that exist in BB but were not spawned by the plugin (attach candidates). */
  addForeign(thread: Partial<ThreadInfo> & { id: string; projectId: string }): FakeThread;
  /** Append a finished turn answering the delivered text that carries `marker`. */
  answer(threadId: string, marker: string, text: string, status?: "completed" | "failed"): void;
  opened: { threadId: string; split: OpenSplit }[];
};

export const FAKE_LOCAL_HOST = "host_local";

export function createFakeThreadPort(): FakeThreadPort {
  const threads = new Map<string, FakeThread>();
  const calls: { method: string; args: unknown }[] = [];
  let next = 1;
  const record = (method: string, args: unknown) => calls.push({ method, args });
  const require = (threadId: string) => {
    const thread = threads.get(threadId);
    if (!thread) throw Object.assign(new Error(`Thread ${threadId} not found`), { status: 404 });
    return thread;
  };
  // A copy without the fake-only fields, like the SDK port returns.
  const info = ({ model: _m, metadata: _md, request: _r, inbox: _i, interactions: _x, events: _e, ...rest }: FakeThread): ThreadInfo => ({ ...rest });
  let seq = 0;
  const logEvent = (thread: FakeThread, type: string, data: unknown) => thread.events.push({ seq: ++seq, type, data });
  const port: FakeThreadPort = {
    threads,
    calls,
    spawnFailures: [],
    sendFailures: [],
    modelOverride: new Map(),
    environments: new Map(),
    localHost: FAKE_LOCAL_HOST,
    projectHost: undefined,
    usage: new Map(),
    countCalls: (method) => calls.filter((call) => call.method === method).length,
    async spawn(request) {
      record("spawn", request);
      const failure = port.spawnFailures.shift();
      if (failure !== undefined) throw failure;
      const id = `th_${next++}`;
      const environmentId =
        request.environment.kind === "reuse" ? request.environment.environmentId : `env_${id}`;
      const thread: FakeThread = {
        id,
        projectId: request.projectId,
        providerId: request.providerId,
        parentThreadId: request.parentThreadId,
        title: request.title,
        status: "active",
        archived: false,
        environmentId,
        lastReadAt: null,
        latestAttentionAt: 0,
        model: port.modelOverride.get(request.title) ?? request.model,
        metadata: { ...request.metadata },
        request,
        inbox: [],
        interactions: [],
        events: [],
      };
      threads.set(id, thread);
      logEvent(thread, "client/turn/requested", { requestId: `req_${seq + 1}`, input: [{ type: "text", text: request.prompt }] });
      return info(thread);
    },
    async get(threadId) {
      record("get", threadId);
      const thread = threads.get(threadId);
      return thread ? info(thread) : null;
    },
    async model(threadId) {
      return require(threadId).model;
    },
    async environmentOf(threadId) {
      return require(threadId).environmentId;
    },
    async listOwn(projectId) {
      record("listOwn", projectId);
      return [...threads.values()].filter((thread) => thread.projectId === projectId).map(info);
    },
    async metadata(threadId) {
      return { ...require(threadId).metadata };
    },
    async update(threadId, patch) {
      record("update", { threadId, ...patch });
      const thread = require(threadId);
      if (patch.title !== undefined) thread.title = patch.title;
      if (patch.parentThreadId !== undefined) thread.parentThreadId = patch.parentThreadId;
      if (patch.model !== undefined) thread.model = patch.model;
    },
    async archive(threadId) {
      record("archive", threadId);
      require(threadId).archived = true;
    },
    async delete(threadId) {
      record("delete", threadId);
      const thread = threads.get(threadId);
      if (!thread) return;
      // Like BB: the parent goes, its children stay behind as orphans.
      threads.delete(threadId);
    },
    async children(threadId) {
      return [...threads.values()].filter((thread) => thread.parentThreadId === threadId).map((thread) => thread.id);
    },
    async unarchive(threadId) {
      record("unarchive", threadId);
      require(threadId).archived = false;
    },
    async stop(threadId) {
      record("stop", threadId);
      require(threadId).status = "idle";
    },
    async send(threadId, text, mode) {
      record("send", { threadId, text, mode });
      const failure = port.sendFailures.shift();
      if (failure !== undefined) throw failure;
      const thread = require(threadId);
      thread.inbox.push({ text, mode });
      logEvent(thread, "client/turn/requested", { requestId: `req_${seq + 1}`, input: [{ type: "text", text }] });
      const busy = thread.status !== "idle" && thread.status !== "error";
      if (mode === "queue-if-active" && busy) return "queued";
      thread.status = "active";
      return "sent";
    },
    async openInteractions(threadId) {
      record("openInteractions", threadId);
      return [...require(threadId).interactions];
    },
    async hasMarker(threadId, marker) {
      return require(threadId).inbox.some((entry) => entry.text.includes(marker));
    },
    async environmentInfo(environmentId) {
      // Worktrees live on the project's source host, like BB's managed worktrees.
      return { hostId: port.projectHost === undefined ? port.localHost : port.projectHost, ...(port.environments.get(environmentId) ?? { path: `/work/${environmentId}`, branch: `bb/${environmentId}`, defaultBranch: "main" }) };
    },
    async localHostId() {
      return port.localHost;
    },
    async projectHostId() {
      return port.projectHost === undefined ? port.localHost : port.projectHost;
    },
    async contextUsage(threadId) {
      return port.usage.get(threadId) ?? null;
    },
    async runningCount() {
      return [...threads.values()].filter((thread) => !thread.archived && thread.status === "active").length;
    },
    async setMetadata(threadId, set, remove) {
      record("setMetadata", { threadId, set, remove });
      const thread = require(threadId);
      thread.metadata = { ...thread.metadata, ...set };
      for (const key of remove ?? []) delete thread.metadata[key];
    },
    async clearContext(threadId) {
      record("clearContext", threadId);
      require(threadId).inbox.push({ text: "<context cleared>", mode: "start" });
    },
    async listProject(projectId) {
      return [...threads.values()].filter((thread) => thread.projectId === projectId && !thread.archived).map(info);
    },
    async open(threadId, split) {
      record("open", { threadId, split });
      require(threadId);
      port.opened.push({ threadId, split });
    },
    async reply(threadId, marker) {
      return replyFromEvents(require(threadId).events, marker);
    },
    opened: [],
    addForeign(input) {
      const thread: FakeThread = {
        providerId: "claude-code",
        parentThreadId: null,
        title: null,
        status: "idle",
        archived: false,
        environmentId: `env_${input.id}`,
        lastReadAt: null,
        latestAttentionAt: 0,
        model: "claude-haiku-4-5-20251001",
        metadata: {},
        inbox: [],
        interactions: [],
        events: [],
        ...input,
      };
      threads.set(thread.id, thread);
      return thread;
    },
    answer(threadId, marker, text, status = "completed") {
      const thread = require(threadId);
      const request = [...thread.events].reverse().find((event) => {
        const data = event.data as { input?: { text?: string }[] };
        return event.type === "client/turn/requested" && (data.input ?? []).some((part) => (part.text ?? "").includes(marker));
      });
      if (!request) throw new Error(`fake: nothing with ${marker} reached ${threadId}`);
      logEvent(thread, "turn/input/accepted", { clientRequestId: (request.data as { requestId: string }).requestId });
      logEvent(thread, "item/completed", { item: { type: "agentMessage", text } });
      logEvent(thread, "turn/completed", { status });
      thread.status = "idle";
    },
  };
  return port;
}
