// bb-plugin-graph-studio — backend.
//
// Owns: the graph library, run execution, and durability. The graph model,
// layout, runtime and checkpointer live in lib/ so they stay testable without
// a running server.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { Command } from "@langchain/langgraph";
import {
  END_NODE,
  START_NODE,
  edgeSchema,
  emptyRunState,
  fieldSchema,
  graphSchema,
  nodeExecution,
  spawnExecution,
  validateGraph,
  type Graph,
  type RunState,
} from "./lib/graph";
import { farewellMessage, orphanedWorkers } from "./lib/orphans";
import { compileGraph, GuardStop, type RuntimeHost } from "./lib/runtime";
import {
  describeAttempt,
  describeGraph,
  describeLibrary,
  runTotal,
} from "./lib/describe";
import { SqliteCheckpointer } from "./lib/checkpointer";
import { MIGRATIONS, createStore, type RunRow, type RunStatus } from "./lib/store";
import { RENAMED_TEMPLATES, TEMPLATES, searchGraphs } from "./lib/templates";
import { whileWorkspaceBusy } from "./lib/workspace";
import { ACTIVITY_EVENT_TYPES, describeActivity } from "./lib/activity";
import {
  answerRefusal,
  answerSource,
  approvalMessage,
  approvalSettledMessage,
  type AnswerSource,
  type MessagePart,
} from "./lib/approval";

const problemSchema = z.object({
  level: z.enum(["error", "warning"]),
  message: z.string(),
});

const nodeRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  attempt: z.number(),
  status: z.enum(["running", "done", "failed", "skipped"]),
  childThreadId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  /**
   * What the worker is doing right now; null when it is not running, or when
   * it has done nothing describable yet. Not stored: this is a reading of the
   * present, and a run reopened tomorrow must not show yesterday's last tool
   * call as if it were still happening.
   */
  activity: z.string().nullable(),
});

const runStateSchema = z.object({
  input: z.string(),
  outputs: z.record(z.string(), z.string()),
  fields: z
    .record(
      z.string(),
      z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      ),
    )
    .default({}),
  /** Branch results of a dynamic fan-out, per node id. */
  collected: z
    .record(
      z.string(),
      z.array(z.object({ visit: z.number(), text: z.string() })),
    )
    .default({}),
  /** Why a node gave up, for nodes that route their failure onward. */
  errors: z.record(z.string(), z.string()).default({}),
  /** The fanned-out element of one instance; empty outside a fan-out. */
  item: z.string().default(""),
  visits: z.record(z.string(), z.number()),
  steps: z.number(),
});

const runSchema = z.object({
  id: z.string(),
  graphId: z.string(),
  graph: graphSchema,
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  input: z.string(),
  status: z.enum(["running", "waiting-human", "done", "failed", "stopped"]),
  state: runStateSchema,
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nodeRuns: z.array(nodeRunSchema),
  /** Set while the run sits on a human node. */
  pendingQuestion: z
    .object({ nodeId: z.string(), label: z.string(), question: z.string() })
    .nullable(),
});

export type RunDto = z.infer<typeof runSchema>;
export type NodeRunDto = z.infer<typeof nodeRunSchema>;

export const rpcContract = defineRpcContract({
  listGraphs: {
    input: z.null(),
    output: z.object({
      graphs: z.array(graphSchema),
      templates: z.array(graphSchema),
    }),
  },
  getGraph: {
    input: z.object({ id: z.string() }),
    output: z.object({
      graph: graphSchema.nullable(),
      problems: z.array(problemSchema),
    }),
  },
  saveGraph: {
    input: z.object({ graph: graphSchema }),
    output: z.object({ graph: graphSchema, problems: z.array(problemSchema) }),
  },
  deleteGraph: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  cloneTemplate: {
    input: z.object({ templateId: z.string(), id: z.string(), name: z.string() }),
    output: z.object({ graph: graphSchema }),
  },
  startRun: {
    input: z.object({
      graphId: z.string(),
      input: z.string().trim().min(1).max(8000),
      threadId: z.string().nullable().default(null),
      projectId: z.string().nullable().default(null),
    }),
    output: z.object({ run: runSchema }),
  },
  getRun: {
    input: z.object({ id: z.string() }),
    output: z.object({ run: runSchema.nullable() }),
  },
  listRuns: {
    input: z.object({ threadId: z.string().nullable().default(null) }),
    output: z.object({ runs: z.array(runSchema) }),
  },
  answerHuman: {
    input: z.object({
      runId: z.string(),
      answer: z.string().max(4000),
      /** The approval the panel showed; guards against answering a newer one. */
      nodeId: z.string().optional(),
    }),
    output: z.object({ run: runSchema.nullable() }),
  },
  stopRun: {
    input: z.object({ runId: z.string() }),
    output: z.object({ run: runSchema.nullable() }),
  },
  /** Skills available in a thread's project/environment, for the node editor. */
  listSkills: {
    input: z.object({ threadId: z.string().nullable().default(null) }),
    output: z.object({
      skills: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable(),
          scope: z.string(),
        }),
      ),
      error: z.string().nullable(),
    }),
  },
  /** Points a run could be restarted from — one per pending superstep. */
  listCheckpoints: {
    input: z.object({ runId: z.string() }),
    output: z.object({
      checkpoints: z.array(
        z.object({
          checkpointId: z.string(),
          /** Node ids that were still to run at this point. */
          next: z.array(z.string()),
          doneCount: z.number(),
        }),
      ),
    }),
  },
  rerunFrom: {
    input: z.object({ runId: z.string(), checkpointId: z.string() }),
    output: z.object({ run: runSchema.nullable() }),
  },
  exportGraph: {
    input: z.object({ id: z.string() }),
    output: z.object({ filename: z.string(), json: z.string() }),
  },
  importGraph: {
    input: z.object({ json: z.string().max(500_000), overwrite: z.boolean().default(false) }),
    output: z.object({ graph: graphSchema }),
  },
});

/**
 * The on-disk shape. Versioned so a file written today stays readable, and
 * stripped of timestamps because those belong to the row, not the document.
 */
export const GRAPH_FILE_VERSION = 1 as const;

/**
 * Drop every value the schema would fill in anyway.
 *
 * An export that writes out each default is 156 lines where 84 would do, and
 * the noise is not free: a graph file lives in a repo, gets read in review and
 * diffed against the next version, and `"providerId": null` on every node
 * buries the one line that actually changed. Parsing is unaffected — the
 * schema puts the defaults back.
 */
function withoutDefaults<T extends Record<string, unknown>>(
  value: T,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (JSON.stringify(entry) === JSON.stringify(defaults[key])) continue;
    result[key] = entry;
  }
  return result;
}

export function toGraphFile(graph: Graph): string {
  const { createdAt: _created, updatedAt: _updated, ...document } = graph;
  // Defaults taken from the schema itself rather than written out here, so
  // this cannot drift from what a parse would actually produce.
  const graphDefaults = graphSchema.parse({
    id: "x",
    name: "x",
    nodes: [{ id: "n", label: "n" }],
    edges: [],
  });
  const nodeDefaults = graphDefaults.nodes[0]!;
  const edgeDefaults = edgeSchema.parse({ from: "a", to: "b" });
  const fieldDefaults = fieldSchema.parse({ name: "f" });

  const compact = {
    ...withoutDefaults(document, graphDefaults),
    // id and name are identity, never omitted even if they matched a default.
    id: document.id,
    name: document.name,
    nodes: document.nodes.map((node) => ({
      ...withoutDefaults(node, nodeDefaults),
      id: node.id,
      label: node.label,
      ...(node.fields.length > 0
        ? {
            fields: node.fields.map((field) => ({
              ...withoutDefaults(field, fieldDefaults),
              name: field.name,
            })),
          }
        : {}),
    })),
    edges: document.edges.map((edge) => ({
      ...withoutDefaults(edge, edgeDefaults),
      from: edge.from,
      to: edge.to,
    })),
  };
  return `${JSON.stringify({ version: GRAPH_FILE_VERSION, graph: compact }, null, 2)}\n`;
}

export function fromGraphFile(json: string): Graph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  const envelope = z
    .object({ version: z.number(), graph: z.unknown() })
    .safeParse(parsed);
  // A bare graph object is accepted too, so a hand-written file works.
  const candidate = envelope.success ? envelope.data.graph : parsed;
  if (envelope.success && envelope.data.version > GRAPH_FILE_VERSION) {
    throw new Error(
      `The file is version ${envelope.data.version}; this plugin only knows ${GRAPH_FILE_VERSION}.`,
    );
  }
  const graph = graphSchema.safeParse(candidate);
  if (!graph.success) {
    const first = graph.error.issues[0];
    throw new Error(
      `Graph invalid${first ? ` (${first.path.join(".")}: ${first.message})` : ""}.`,
    );
  }
  return graph.data;
}

export default function graphStudio(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);
  const checkpointer = new SqliteCheckpointer(db);

  // Templates are shipped code, not stored rows: seeding them would freeze a
  // stale copy in the database the moment a template is improved. They are
  // exposed read-only and cloned under a new id to edit. Template ids are
  // therefore reserved — drop any row that squats on one.
  for (const template of TEMPLATES) {
    if (store.getGraph(template.id)) store.deleteGraph(template.id);
  }

  /** User graphs first, then the read-only shipped templates. */
  function resolveGraph(id: string): Graph | null {
    const stored = store.getGraph(id);
    // A stored row wins, which is right for a clone but wrong when the id is a
    // template's: then an improvement to the shipped template is invisible and
    // the old copy keeps running. `importGraph` refuses such an id, but a row
    // written *before* a template of that name existed slips past — which is
    // exactly how `gedanke-zu-konzept` and `konzept-wellen` came to shadow
    // themselves. Not resolved silently in either direction: the row still
    // wins, and the log says so.
    if (stored && TEMPLATES.some((entry) => entry.id === id)) {
      bb.log.warn(
        `Graph "${id}" exists as a saved row AND as a template; the saved one wins. Delete it to use the template again.`,
      );
    }
    const template = TEMPLATES.find((entry) => entry.id === id);
    if (stored || template) return stored ?? template!;

    // Nothing under that id — it may be one the library shipped before the
    // templates were renamed. A subgraph node stores its target as a plain id
    // and looks it up here, so without this a graph somebody saved would fail
    // at the node instead of at import.
    const renamed = RENAMED_TEMPLATES[id];
    if (!renamed) return null;
    bb.log.warn(
      `Graph "${id}" was renamed to "${renamed}"; resolving the new one. Update the reference to keep it working.`,
    );
    return store.getGraph(renamed) ?? TEMPLATES.find((e) => e.id === renamed) ?? null;
  }

  /** The whole library, in the order `resolveGraph` searches it. */
  function libraryGraphs(): Graph[] {
    return [...store.listGraphs(), ...TEMPLATES];
  }

  const publish = () => bb.realtime.publish("graph-studio", {});

  /** Interrupt payloads, keyed by run. Rebuilt from the graph on resume. */
  const pending = new Map<
    string,
    { nodeId: string; label: string; question: string }
  >();
  /** Runs whose stop was requested; checked between nodes. */
  const stopping = new Set<string>();
  /**
   * Approvals posted into the thread that started the run, keyed by run. Only
   * these owe the chat a closing note when they are settled elsewhere. In
   * memory like `pending`: after a reload the note is skipped, and the tool
   * still refuses an answer to a settled approval.
   */
  const announced = new Map<string, { threadId: string; label: string }>();

  /** Best effort: a message that cannot be delivered must not stall a run. */
  async function postToThread(runId: string, threadId: string, input: MessagePart[]) {
    try {
      // `queue-if-active`: the starting thread may still be in the turn that
      // started the run, and a steer would cut that turn short.
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input });
    } catch (cause) {
      bb.log.warn(
        `[run ${runId}] Could not post to thread ${threadId}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  /** Ask in the starting thread. Only human nodes: a dialogue has its own worker. */
  function announceApproval(
    row: RunRow,
    ask: { nodeId: string; label: string; question: string },
  ) {
    if (!row.threadId) return;
    const node = row.graph.nodes.find((entry) => entry.id === ask.nodeId);
    if (node?.kind !== "human") return;
    announced.set(row.id, { threadId: row.threadId, label: ask.label });
    void postToThread(
      row.id,
      row.threadId,
      approvalMessage({ runId: row.id, graphName: row.graph.name, ...ask }),
    );
  }

  /** Close the chat's approval when it was settled anywhere but the chat. */
  function settleAnnouncement(
    runId: string,
    outcome:
      | { kind: "answered"; answer: string; source: AnswerSource }
      | { kind: "stopped" },
  ) {
    const entry = announced.get(runId);
    if (!entry) return;
    announced.delete(runId);
    if (outcome.kind === "answered" && outcome.source === "chat") return;
    void postToThread(
      runId,
      entry.threadId,
      approvalSettledMessage({ runId, label: entry.label, outcome }),
    );
  }

  /**
   * The current activity line per node_run, in memory only.
   *
   * Deliberately not a column: it is true for a few seconds, it is derivable
   * from the worker thread at any time, and a stored copy would come back on
   * reload as a claim about the present that nobody is checking any more.
   */
  const activity = new Map<string, string>();
  /** One poll timer per running run. */
  const watchers = new Map<string, ReturnType<typeof setInterval>>();

  /** How often a running run asks its workers what they are doing. */
  const ACTIVITY_POLL_MS = 3_000;

  /**
   * Read the activity of every worker this run has in flight.
   *
   * A run has one worker per running node — typically one, at most `maxFanOut`
   * — so this is a handful of calls every few seconds, and only while
   * something is actually running. Publishes only on a change: a node that
   * spends two minutes in the same tool call must not re-render the canvas
   * forty times to say so.
   */
  async function pollActivity(runId: string) {
    const rows = store.listNodeRuns(runId);
    let changed = false;
    // Attempts that have finished since the last poll: their line described
    // something that is over, and leaving it would freeze the last tool call
    // under a node that is long done.
    for (const row of rows) {
      if (row.status !== "running" && activity.delete(row.id)) changed = true;
    }
    const running = rows.filter(
      (row) => row.status === "running" && row.childThreadId !== null,
    );
    await Promise.all(
      running.map(async (row) => {
        try {
          const events = await bb.sdk.threads.events.list({
            threadId: row.childThreadId!,
            types: ACTIVITY_EVENT_TYPES,
            order: "desc",
            limit: "1",
          });
          const line = describeActivity(events[0]?.data);
          // Null means the newest event said nothing a reader could use —
          // keep what was there rather than blanking a line that was true.
          if (line === null || activity.get(row.id) === line) return;
          activity.set(row.id, line);
          changed = true;
        } catch (cause) {
          // A nicety must never disturb a run. One line at debug level,
          // because a worker that is being archived will fail this call and
          // that is not worth a warning every three seconds.
          bb.log.debug(
            `Activity of ${row.childThreadId} unreadable: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }),
    );
    if (changed) publish();
  }

  function watchActivity(runId: string) {
    if (watchers.has(runId)) return;
    const timer = setInterval(() => {
      void pollActivity(runId);
    }, ACTIVITY_POLL_MS);
    // Node keeps the process alive for a pending interval; a poll timer is not
    // a reason to stay up.
    timer.unref?.();
    watchers.set(runId, timer);
  }

  function unwatchActivity(runId: string) {
    const timer = watchers.get(runId);
    if (timer) clearInterval(timer);
    watchers.delete(runId);
    for (const row of store.listNodeRuns(runId)) activity.delete(row.id);
  }

  function toDto(runId: string): RunDto | null {
    const row = store.getRun(runId);
    if (!row) return null;
    return {
      ...row,
      state: row.state as RunState,
      nodeRuns: store
        .listNodeRuns(runId)
        .map((nodeRun) => ({
          ...nodeRun,
          activity: activity.get(nodeRun.id) ?? null,
        })),
      pendingQuestion: pending.get(runId) ?? null,
    };
  }

  /**
   * What a worker thread consumed, from BB's own accounting.
   *
   * Returns nulls rather than zeros whenever the answer is not knowable — no
   * thread, no usage event, a provider that does not report. A zero would
   * claim the node was free, and an inspector cannot tell an honest zero from
   * a missing measurement afterwards.
   */
  async function tokenUsage(
    threadId: string | null,
  ): Promise<{ inputTokens: number | null; outputTokens: number | null }> {
    const none = { inputTokens: null, outputTokens: null };
    if (!threadId) return none;
    try {
      // Descending, limit 1: the last event carries the running total for the
      // whole thread, so earlier ones would double-count if summed.
      const events = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated"],
        order: "desc",
        limit: "1",
      });
      const last = events[0];
      if (!last) return none;
      const total = (
        last.data as {
          tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number } };
        }
      ).tokenUsage?.total;
      if (!total) return none;
      return {
        inputTokens: total.inputTokens ?? null,
        outputTokens: total.outputTokens ?? null,
      };
    } catch (cause) {
      // Accounting must never fail a node that did its work.
      bb.log.warn(
        `Usage of ${threadId} unreadable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return none;
    }
  }

  function makeHost(
    runId: string,
    parentThreadId: string | null,
    projectId: string | null,
  ): RuntimeHost {
    return {
      async spawn({ prompt, title, execution }) {
        if (stopping.has(runId)) throw new GuardStop("The run was stopped.");
        if (!parentThreadId) {
          throw new Error("A run needs a parent thread.");
        }
        // Reuse the parent's environment so workers land in the same
        // worktree the user is looking at, not a fresh checkout.
        const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
        if (!parent.environmentId) {
          throw new Error(
            `Parent thread ${parentThreadId} has no environment a worker could inherit.`,
          );
        }
        // Read out once: inside the retry closure TypeScript can no longer
        // rely on the check above.
        const environmentId = parent.environmentId;
        const projectIdForChild = projectId ?? parent.projectId;
        // A node without its own selection inherits the parent's provider. It
        // has to be named explicitly — omitting it makes BB reach for project
        // and catalog defaults instead. See `spawnExecution`.
        const chosen = spawnExecution(execution, parent.providerId);
        // BB does not accept a model without its provider, and provenance only
        // describes what the graph actually decided.
        const executionArgs =
          chosen === null
            ? {}
            : {
                providerId: chosen.providerId,
                ...(chosen.model !== null ? { model: chosen.model } : {}),
                ...(chosen.reasoningLevel
                  ? { reasoningLevel: chosen.reasoningLevel }
                  : {}),
                ...(chosen.serviceTier
                  ? { serviceTier: chosen.serviceTier }
                  : {}),
                ...(chosen.explicit
                  ? {
                      executionInputSources: {
                        providerId: "explicit" as const,
                        model: "explicit" as const,
                        ...(chosen.reasoningLevel
                          ? { reasoningLevel: "explicit" as const }
                          : {}),
                        ...(chosen.serviceTier
                          ? { serviceTier: "explicit" as const }
                          : {}),
                      },
                    }
                  : {}),
              };
        // BB releases the previous worker's hold on the environment a moment
        // after that thread reports `idle`, so a node that spawns the next
        // worker right away is refused with 409 `workspace_busy`. Wait that gap
        // out instead of failing the node — see lib/workspace.ts.
        const child = await whileWorkspaceBusy(
          () =>
            bb.sdk.threads.spawn({
              prompt,
              title,
              visibility: "visible",
              origin: "plugin",
              parentThreadId,
              projectId: projectIdForChild,
              environment: { type: "reuse", environmentId },
              ...executionArgs,
            }),
          {
            onWait: (attempt, waitedMs) =>
              bb.log.info(
                `Working copy still busy, waiting for it to free up (attempt ${attempt}, ${waitedMs} ms).`,
              ),
          },
        );
        return child.id;
      },
      async awaitThread(threadId) {
        // `wait` is race-free: it resolves immediately if the thread already
        // reached the status, so a fast child cannot slip past a listener.
        await bb.sdk.threads.wait({
          threadId,
          status: "idle",
          timeoutMs: 1000 * 60 * 60 * 6,
        });
        const { output } = await bb.sdk.threads.output({ threadId });
        if (output == null || output.trim() === "") {
          throw new Error(`Thread ${threadId} returned no result.`);
        }
        return output;
      },
      async sendMessage(threadId: string, text: string) {
        if (stopping.has(runId)) throw new GuardStop("The run was stopped.");
        await bb.sdk.threads.send({
          threadId,
          mode: "start",
          input: [{ type: "text", text, mentions: [] }],
        });
        // The caller now waits for `idle`, and a thread that has not picked
        // the message up yet is *still* idle — so without this the next wait
        // returns instantly and hands back the previous answer. Waiting for
        // the turn to start closes that window. A timeout here is not fatal:
        // the answer check downstream catches a thread that never moved.
        try {
          await bb.sdk.threads.wait({
            threadId,
            status: "active",
            timeoutMs: 1000 * 60 * 2,
          });
        } catch {
          bb.log.info(`[run ${runId}] Thread ${threadId} never became active.`);
        }
      },
      async loadDialog(nodeId: string, visit: number) {
        return store.getDialog(runId, nodeId, visit);
      },
      async saveDialog(
        nodeId: string,
        visit: number,
        session: { threadId: string; turns: number },
      ) {
        store.saveDialog(runId, nodeId, visit, session);
      },
      async onNodeThread(nodeRunId: string, threadId: string) {
        store.attachThread(nodeRunId, threadId);
        publish();
      },
      async onNodeStart(nodeId: string) {
        // A dialogue node re-enters this hook on every interrupt replay, but
        // it is one conversation. Reuse the open row, or the run history would
        // count each answered question as another attempt.
        const kind = store
          .getRun(runId)
          ?.graph.nodes.find((node) => node.id === nodeId)?.kind;
        if (kind === "dialog") {
          const open = store.findRunningNodeRun(runId, nodeId);
          if (open) return open.id;
        }
        const id = randomUUID();
        store.insertNodeRun({
          id,
          runId,
          nodeId,
          attempt: store.countAttempts(runId, nodeId) + 1,
          status: "running",
          childThreadId: null,
          output: null,
          error: null,
          startedAt: Date.now(),
          endedAt: null,
          inputTokens: null,
          outputTokens: null,
        });
        publish();
        return id;
      },
      async onNodeFinish(nodeRunId, patch) {
        store.updateNodeRun(nodeRunId, {
          ...patch,
          endedAt: Date.now(),
          // The worker is idle at this point, so its last usage event is the
          // final one for this node. Read here rather than live: a node is
          // billed once it is done, and polling a running thread would add
          // traffic per superstep for a number nobody can act on yet.
          ...(await tokenUsage(patch.childThreadId)),
        });
        publish();
      },
      async onStateChange(state) {
        const row = store.getRun(runId);
        if (!row) return;
        store.updateRun(
          runId,
          { status: row.status, state, error: row.error },
          Date.now(),
        );
        publish();
      },
      log: (message) => bb.log.info(`[run ${runId}] ${message}`),
    };
  }

  /**
   * Nodes whose explicit model the executing machine does not offer, as ready
   * German sentences. Empty when every named model resolves — and also when the
   * catalog itself could not be read: a provider hiccup must not stop a run
   * that would otherwise work. The check is fail-closed on a definite mismatch
   * and fail-open on an unanswerable question.
   */
  async function unknownModels(
    graph: Graph,
    parentThreadId: string | null,
  ): Promise<string[]> {
    const wanted = graph.nodes
      .map((node) => ({ node, execution: nodeExecution(node) }))
      .filter((entry) => entry.execution !== null);
    if (wanted.length === 0 || !parentThreadId) return [];

    let catalog;
    try {
      // The catalog is per environment: a provider may offer different models
      // on a remote machine than on this one, so asking globally would bless a
      // model the worker's own machine cannot run.
      const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
      if (!parent.environmentId) return [];
      catalog = await bb.sdk.providers.models({
        environmentId: parent.environmentId,
      });
    } catch (cause) {
      bb.log.warn(
        `Model catalogue unreadable, model check skipped: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return [];
    }

    const providers = new Set(
      catalog.providers.filter((entry) => entry.available).map((entry) => entry.id),
    );
    // A catalog entry carries both an id and the provider-facing model name;
    // either is a legitimate thing for a stored graph to name.
    const models = new Set(
      catalog.models.flatMap((entry) => [entry.id, entry.model]),
    );

    const problems: string[] = [];
    for (const { node, execution } of wanted) {
      if (!execution) continue;
      if (!providers.has(execution.providerId)) {
        problems.push(
          `"${node.label}" names the provider "${execution.providerId}", which this machine does not offer`,
        );
        continue;
      }
      if (!models.has(execution.model)) {
        problems.push(
          `"${node.label}" names the model "${execution.model}", which does not appear in the catalogue of "${execution.providerId}"`,
        );
      }
    }
    return problems;
  }

  /**
   * Drive a run to its next stopping point: completion, a human node, a guard,
   * or a failure. Runs in the background; the UI follows over realtime.
   */
  async function drive(
    runId: string,
    resume?: string,
    fromCheckpointId?: string,
  ) {
    const row = store.getRun(runId);
    if (!row) return;
    const host = makeHost(runId, row.threadId, row.projectId);

    // Models are named in the graph but resolved on the machine that runs it.
    // A graph imported from elsewhere — or one authored while another provider
    // was installed — can name a model this host does not have, and BB would
    // quietly fall back to the inherited one. A silent downgrade is the worst
    // outcome here: the run looks right and costs or capability differ.
    const unknown = await unknownModels(row.graph, row.threadId);
    if (unknown.length > 0) {
      store.updateRun(
        runId,
        {
          status: "failed",
          state: row.state as RunState,
          error: `Unknown model choice: ${unknown.join("; ")}`,
        },
        Date.now(),
      );
      publish();
      return;
    }

    const app = compileGraph(row.graph, host, checkpointer, resolveGraph);
    // From here on there are workers to ask. Started before `invoke`, stopped
    // in the `finally` below, so no run can leave a timer behind.
    watchActivity(runId);
    const config = {
      configurable: {
        thread_id: runId,
        ...(fromCheckpointId ? { checkpoint_id: fromCheckpointId } : {}),
      },
      recursionLimit: 200,
    };

    try {
      // `null` means "continue from the checkpoint named in the config" —
      // LangGraph replays the pending nodes and leaves finished ones alone.
      const input =
        fromCheckpointId !== undefined
          ? null
          : resume === undefined
            ? { ...emptyRunState(row.input), ...(row.state as RunState) }
            : new Command({ resume });
      const result = (await app.invoke(input as never, config)) as RunState & {
        __interrupt__?: Array<{ value: unknown }>;
      };

      const headConfig = { configurable: { thread_id: runId } };
      const interrupts = (await app.getState(headConfig)).tasks.flatMap(
        (task) => task.interrupts ?? [],
      );
      if (interrupts.length > 0) {
        const value = interrupts[0]!.value as {
          nodeId: string;
          label: string;
          question: string;
        };
        pending.set(runId, value);
        store.updateRun(
          runId,
          { status: "waiting-human", state: result, error: null },
          Date.now(),
        );
        publish();
        announceApproval(row, value);
        return;
      }

      pending.delete(runId);
      store.updateRun(
        runId,
        {
          status: stopping.has(runId) ? "stopped" : "done",
          state: result,
          error: null,
        },
        Date.now(),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const status: RunStatus =
        cause instanceof GuardStop || stopping.has(runId) ? "stopped" : "failed";
      const current = store.getRun(runId);
      store.updateRun(
        runId,
        { status, state: current?.state ?? {}, error: message },
        Date.now(),
      );
      bb.log.warn(`Run ${runId} ended: ${message}`);
      await farewellWorkers(runId, status, message);
    } finally {
      unwatchActivity(runId);
      stopping.delete(runId);
      publish();
    }
  }

  /** One implementation behind RPC, CLI and the agent tools. */
  function startRun(args: {
    graphId: string;
    input: string;
    threadId: string | null;
    projectId: string | null;
  }): string {
    const graph = resolveGraph(args.graphId);
    if (!graph) throw new Error(`Unknown graph ${args.graphId}`);
    if (!args.threadId) {
      throw new Error(
        "A run needs a parent thread whose environment the workers inherit.",
      );
    }
    const errors = validateGraph(graph, resolveGraph).filter(
      (problem) => problem.level === "error",
    );
    if (errors.length > 0) {
      throw new Error(
        `Graph is not runnable: ${errors.map((e) => e.message).join(" ")}`,
      );
    }
    const now = Date.now();
    const runId = `run_${randomUUID().slice(0, 12)}`;
    store.insertRun({
      id: runId,
      graphId: args.graphId,
      graph,
      threadId: args.threadId,
      projectId: args.projectId,
      input: args.input,
      status: "running",
      state: emptyRunState(args.input),
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    publish();
    void drive(runId);
    return runId;
  }

  /**
   * Synchronous from the check to the status change, so of two answers racing
   * in from chat and panel exactly one resumes the run; the other is refused.
   */
  function answerHuman(
    runId: string,
    answer: string,
    via: { source: AnswerSource; nodeId?: string } = { source: "elsewhere" },
  ) {
    const row = store.getRun(runId);
    if (!row) throw new Error(`No run ${runId}.`);
    const refusal = answerRefusal({
      status: row.status,
      pendingNodeId: pending.get(runId)?.nodeId ?? null,
      expectedNodeId: via.nodeId,
    });
    if (refusal) throw new Error(refusal);
    pending.delete(runId);
    settleAnnouncement(runId, { kind: "answered", answer, source: via.source });
    store.updateRun(
      runId,
      { status: "running", state: row.state, error: null },
      Date.now(),
    );
    publish();
    void drive(runId, answer);
  }

  /** Restart points of a run: one per superstep that still had work pending. */
  async function listCheckpointsFor(row: RunRow): Promise<{
    checkpoints: Array<{ checkpointId: string; next: string[]; doneCount: number }>;
  }> {
    const host = makeHost(row.id, row.threadId, row.projectId);
    const app = compileGraph(row.graph, host, checkpointer, resolveGraph);
    const checkpoints: Array<{
      checkpointId: string;
      next: string[];
      doneCount: number;
    }> = [];
    for await (const snapshot of app.getStateHistory({
      configurable: { thread_id: row.id },
    })) {
      const next = [...snapshot.next].filter(
        (id) => id !== START_NODE && id !== END_NODE,
      );
      if (next.length === 0) continue;
      const id = snapshot.config.configurable?.checkpoint_id;
      if (typeof id !== "string") continue;
      const values = snapshot.values as Partial<RunState>;
      checkpoints.push({
        checkpointId: id,
        next,
        doneCount: Object.keys(values.outputs ?? {}).length,
      });
    }
    return { checkpoints };
  }

  function rerunFrom(runId: string, checkpointId: string) {
    const row = store.getRun(runId);
    if (!row) throw new Error(`No run ${runId}.`);
    if (row.status === "running") {
      throw new Error("That run is in progress. Stop it first, then retry.");
    }
    stopping.delete(runId);
    pending.delete(runId);
    // A rerun replays the graph and asks again if it reaches the node again.
    announced.delete(runId);
    store.updateRun(
      runId,
      { status: "running", state: row.state, error: null },
      Date.now(),
    );
    publish();
    void drive(runId, undefined, checkpointId);
  }

  function requestStop(runId: string) {
    stopping.add(runId);
    const row = store.getRun(runId);
    if (row && row.status === "waiting-human") {
      pending.delete(runId);
      settleAnnouncement(runId, { kind: "stopped" });
      store.updateRun(
        runId,
        { status: "stopped", state: row.state, error: null },
        Date.now(),
      );
      publish();
      // Nothing is driving this run any more, so nobody else will say it.
      // A run that is still `running` reaches `drive`'s catch instead.
      void farewellWorkers(runId, "stopped", null);
    }
  }

  /**
   * Tell the workers a run leaves behind that it is over. See lib/orphans.ts
   * for who counts as left behind and why they are told rather than stopped.
   *
   * `steer-if-active`: an idle worker — the dialogue thread waiting for an
   * answer — gets the message as a new turn; one still mid-turn is steered
   * rather than queued behind work it should no longer finish. Best effort
   * per thread: a goodbye that cannot be delivered must not mask the failure
   * that ended the run.
   */
  async function farewellWorkers(
    runId: string,
    status: "failed" | "stopped",
    error: string | null,
  ) {
    const threads = orphanedWorkers(
      store.listNodeRuns(runId),
      store.listDialogs(runId),
    );
    if (threads.length === 0) return;
    const text = farewellMessage(status, error);
    await Promise.all(
      threads.map(async (threadId) => {
        try {
          await bb.sdk.threads.send({
            threadId,
            mode: "steer-if-active",
            input: [{ type: "text", text, mentions: [] }],
          });
          bb.log.info(`[run ${runId}] Told worker ${threadId} that the run ended.`);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          bb.log.warn(
            `[run ${runId}] Could not tell worker ${threadId} that the run ended: ${message}`,
          );
        }
      }),
    );
  }

  bb.rpc.register(rpcContract, {
    listGraphs: () => ({
      graphs: [...store.listGraphs(), ...TEMPLATES],
      templates: TEMPLATES,
    }),
    getGraph: ({ id }) => {
      const graph = resolveGraph(id);
      return { graph, problems: graph ? validateGraph(graph, resolveGraph) : [] };
    },
    saveGraph: ({ graph }) => {
      const saved = store.saveGraph(graph, Date.now());
      publish();
      return { graph: saved, problems: validateGraph(saved, resolveGraph) };
    },
    deleteGraph: ({ id }) => {
      store.deleteGraph(id);
      publish();
      return { ok: true };
    },
    cloneTemplate: ({ templateId, id, name }) => {
      const template = TEMPLATES.find((entry) => entry.id === templateId);
      if (!template) throw new Error(`Unknown template ${templateId}`);
      if (resolveGraph(id)) {
        throw new Error(`A graph "${id}" already exists.`);
      }
      const graph = store.saveGraph(
        { ...template, id, name, createdAt: 0 },
        Date.now(),
      );
      publish();
      return { graph };
    },
    startRun: ({ graphId, input, threadId, projectId }) => {
      const runId = startRun({ graphId, input, threadId, projectId });
      return { run: toDto(runId)! };
    },
    getRun: ({ id }) => ({ run: toDto(id) }),
    listRuns: ({ threadId }) => {
      const rows = threadId ? store.listRunsByThread(threadId) : store.listRuns();
      return {
        runs: rows.flatMap((row) => {
          const dto = toDto(row.id);
          return dto ? [dto] : [];
        }),
      };
    },
    answerHuman: ({ runId, answer, nodeId }) => {
      answerHuman(runId, answer, { source: "panel", nodeId });
      return { run: toDto(runId) };
    },
    stopRun: ({ runId }) => {
      requestStop(runId);
      return { run: toDto(runId) };
    },
    listSkills: async ({ threadId }) => {
      // Skills are resolved per project + environment, so they need a thread
      // for context. A failure here is informational: the editor still lets
      // the user type a skill id by hand.
      if (!threadId) return { skills: [], error: "No thread selected." };
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const { skills } = await bb.sdk.skills.list({
          projectId: thread.projectId,
          environmentId: thread.environmentId ?? null,
        });
        return {
          skills: skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
          error: null,
        };
      } catch (cause) {
        return {
          skills: [],
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    listCheckpoints: async ({ runId }) => {
      const row = store.getRun(runId);
      if (!row) return { checkpoints: [] };
      return listCheckpointsFor(row);
    },
    rerunFrom: ({ runId, checkpointId }) => {
      rerunFrom(runId, checkpointId);
      return { run: toDto(runId) };
    },
    exportGraph: ({ id }) => {
      const graph = resolveGraph(id);
      if (!graph) throw new Error(`Unknown graph ${id}`);
      return { filename: `${graph.id}.graph.json`, json: toGraphFile(graph) };
    },
    importGraph: ({ json, overwrite }) => {
      const graph = fromGraphFile(json);
      if (TEMPLATES.some((entry) => entry.id === graph.id)) {
        throw new Error(
          `"${graph.id}" is a shipped template. Give the import a different id.`,
        );
      }
      if (!overwrite && store.getGraph(graph.id)) {
        throw new Error(
          `A graph "${graph.id}" already exists. Confirm overwriting explicitly.`,
        );
      }
      const saved = store.saveGraph(graph, Date.now());
      publish();
      return { graph: saved };
    },
  });

  const CLI_COMMANDS = [
      {
        name: "graphs",
        summary: "List graphs, optionally filtered",
        usage: "bb graph-studio graphs [search]",
      },
      {
        name: "show",
        summary: "Show a graph and what the check says",
        usage: "bb graph-studio show <graph-id>",
      },
      {
        name: "run",
        summary: "Start a run",
        usage: 'bb graph-studio run <graph-id> "<task>"',
      },
      { name: "runs", summary: "List runs", usage: "bb graph-studio runs" },
      {
        name: "status",
        summary: "Show one run in detail",
        usage: "bb graph-studio status <run-id>",
      },
      {
        name: "answer",
        summary: "Answer a waiting approval",
        usage: 'bb graph-studio answer <run-id> "<answer>"',
      },
      { name: "stop", summary: "Stop a run", usage: "bb graph-studio stop <run-id>" },
      {
        name: "checkpoints",
        summary: "Show a run's checkpoints",
        usage: "bb graph-studio checkpoints <run-id>",
      },
      {
        name: "rerun",
        summary: "Resume a run from a checkpoint",
        usage: "bb graph-studio rerun <run-id> <checkpoint-id>",
      },
      {
        name: "delete",
        summary: "Delete a graph of your own (templates stay)",
        usage: "bb graph-studio delete <graph-id>",
      },
      {
        name: "export",
        summary: "Write a graph as JSON to stdout",
        usage: "bb graph-studio export <graph-id> > my-graph.graph.json",
      },
      {
        name: "import",
        summary: "Read a graph from a JSON file",
        usage: "bb graph-studio import <file.json> [--overwrite]",
      },
  ];

  /** The command list as text — what `help` prints and what a wrong command earns. */
  const usageText = [
    "bb graph-studio <command>",
    "",
    ...CLI_COMMANDS.map((entry) => `  ${entry.usage.padEnd(56)} ${entry.summary}`),
    "",
    // The best way to start a run is the one the command list cannot show,
    // because it is not a command. A run's nodes are fresh threads: whatever
    // was settled in a conversation reaches them only if somebody writes it
    // into the task. The agent in that conversation can do it and start the
    // run itself — and `--help` is where someone looks for what is possible,
    // at no cost in the panel, where vertical space is the scarce thing.
    "A run's task is the only context it gets — its nodes are fresh threads and",
    "cannot see your conversation. Rather than retyping what was settled, ask the",
    "agent in that thread; it reads all of it and starts the run itself:",
    "",
    '  "Summarise what we settled here and start concept-domain with it"',
  ].join("\n");

  bb.cli.register({
    name: "graph-studio",
    summary: "Build graphs and steer runs (cycles, routing, approvals)",
    commands: CLI_COMMANDS,
    run: async (argv: string[], ctx) => {
      const [command, ...rest] = argv;
      const ok = (stdout: string) => ({ exitCode: 0, stdout: `${stdout}\n` });
      const fail = (stderr: string) => ({ exitCode: 1, stderr: `${stderr}\n` });

      switch (command) {
        // Without this, the "see --help" hint below led into the same error
        // it was pointing away from.
        case undefined:
        case "help":
        case "--help":
        case "-h": {
          return ok(usageText);
        }
        case "graphs": {
          const term = rest.join(" ");
          const found = searchGraphs(libraryGraphs(), term);
          // A search that finds nothing says so, and says what it looked for.
          // An empty listing reads as an empty library.
          if (found.length === 0) {
            return ok(`No graph matches "${term}".`);
          }
          return ok(describeLibrary(found));
        }
        case "show": {
          const graph = rest[0] ? resolveGraph(rest[0]) : null;
          if (!graph) return fail("Graph not found.");
          return ok(describeGraph(graph, validateGraph(graph, resolveGraph)));
        }
        case "run": {
          const [graphId, ...task] = rest;
          if (!graphId || task.length === 0) {
            return fail('Usage: bb graph-studio run <graph-id> "<task>"');
          }
          const runIdStarted = startRun({
            graphId,
            input: task.join(" "),
            threadId: ctx.threadId ?? null,
            projectId: ctx.projectId ?? null,
          });
          return ok(`Run started: ${runIdStarted}`);
        }
        case "runs": {
          return ok(
            store
              .listRuns(20)
              .map((row) => `${row.id}  ${row.status.padEnd(14)} ${row.graphId}`)
              .join("\n") || "No runs.",
          );
        }
        case "status": {
          const dto = rest[0] ? toDto(rest[0]) : null;
          if (!dto) return fail("Run not found.");
          const lines = [
            `${dto.id}  ${dto.status}`,
            `Graph: ${dto.graph.name}`,
            `Task: ${dto.input}`,
            dto.error ? `Error: ${dto.error}` : "",
            "",
            ...dto.nodeRuns.map((node) => describeAttempt(node, Date.now())),
            // The run total answers the question the per-node lines raise.
            // Empty when nothing was measured, and then the blank line and the
            // heading go away with it.
            ...(runTotal(dto.nodeRuns) ? ["", runTotal(dto.nodeRuns)] : []),
            dto.pendingQuestion
              ? `\nWaiting for an answer: ${dto.pendingQuestion.question}`
              : "",
          ];
          return ok(lines.filter(Boolean).join("\n"));
        }
        case "answer": {
          const [runId, ...answer] = rest;
          if (!runId) return fail("Usage: bb graph-studio answer <run-id> <answer>");
          const row = store.getRun(runId);
          try {
            answerHuman(runId, answer.join(" "), {
              source: answerSource(ctx.threadId, row?.threadId ?? null),
            });
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : String(cause));
          }
          return ok("Answer taken.");
        }
        case "stop": {
          if (!rest[0]) return fail("Usage: bb graph-studio stop <run-id>");
          requestStop(rest[0]);
          return ok("Stopping the run.");
        }
        case "checkpoints": {
          const runId = rest[0];
          if (!runId) return fail("Usage: bb graph-studio checkpoints <run-id>");
          const row = store.getRun(runId);
          if (!row) return fail("Run not found.");
          const { checkpoints } = await listCheckpointsFor(row);
          if (checkpoints.length === 0) return ok("No checkpoints.");
          const labelOf = (id: string) =>
            row.graph.nodes.find((node) => node.id === id)?.label ?? id;
          return ok(
            checkpoints
              .map(
                (entry) =>
                  `${entry.checkpointId}  before ${entry.next.map(labelOf).join(", ")}  (${entry.doneCount} ${entry.doneCount === 1 ? "result" : "results"} available)`,
              )
              .join("\n"),
          );
        }
        case "rerun": {
          const [runId, checkpointId] = rest;
          if (!runId || !checkpointId) {
            return fail("Usage: bb graph-studio rerun <run-id> <checkpoint-id>");
          }
          try {
            rerunFrom(runId, checkpointId);
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : String(cause));
          }
          return ok(`Run ${runId} resumes from ${checkpointId}.`);
        }
        case "delete": {
          const id = rest[0];
          if (!id) return fail("Usage: bb graph-studio delete <graph-id>");
          if (TEMPLATES.some((entry) => entry.id === id)) {
            return fail(`"${id}" is a shipped template and stays.`);
          }
          if (!store.getGraph(id)) return fail(`No graph of your own called "${id}".`);
          store.deleteGraph(id);
          publish();
          return ok(`Deleted: ${id}`);
        }
        case "export": {
          const graph = rest[0] ? resolveGraph(rest[0]) : null;
          if (!graph) return fail("Graph not found.");
          // Raw JSON on stdout so it can be redirected straight into the repo.
          return { exitCode: 0, stdout: toGraphFile(graph) };
        }
        case "import": {
          const file = rest.find((arg) => !arg.startsWith("--"));
          if (!file) {
            return fail("Usage: bb graph-studio import <file.json> [--overwrite]");
          }
          let json: string;
          try {
            json = await readFile(resolve(file), "utf8");
          } catch (cause) {
            return fail(
              `File unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
          try {
            const graph = fromGraphFile(json);
            if (TEMPLATES.some((entry) => entry.id === graph.id)) {
              return fail(
                `"${graph.id}" is a shipped template. Give the import a different id.`,
              );
            }
            if (!rest.includes("--overwrite") && store.getGraph(graph.id)) {
              return fail(
                `A graph "${graph.id}" already exists. Replace it with --overwrite.`,
              );
            }
            const saved = store.saveGraph(graph, Date.now());
            publish();
            return ok(`Imported: ${saved.id} (${saved.nodes.length} nodes)`);
          } catch (cause) {
            return fail(cause instanceof Error ? cause.message : String(cause));
          }
        }
        default:
          return fail(`Unknown command "${command}".\n\n${usageText}`);
      }
    },
  });

  // Reading tools. Without them a model can start a graph whose id it already
  // knows, but cannot find out which graphs exist or what one does — the
  // description sits in the CLI, reachable only by whoever knows the CLI.
  bb.agents.registerTool({
    name: "graph_studio_graphs",
    description:
      "List the Graph Studio library: one line per graph with its id, node count and name. Use this before graph_studio_describe or graph_studio_run.",
    parameters: z.object({}),
    execute: async () => describeLibrary(libraryGraphs()),
  });

  bb.agents.registerTool({
    name: "graph_studio_describe",
    description:
      "Describe one Graph Studio graph: purpose, nodes with their kind, skills and declared fields, all edges with their routing conditions, and the validator's findings. Use this to talk about what a graph does before running it.",
    parameters: z.object({ graphId: z.string() }),
    execute: async ({ graphId }) => {
      const graph = resolveGraph(graphId);
      if (!graph) {
        // Naming the alternatives beats "not found": the usual cause is a
        // guessed id, and the list is the answer to the next question anyway.
        return `No graph "${graphId}". Available:\n${describeLibrary(libraryGraphs())}`;
      }
      return describeGraph(graph, validateGraph(graph, resolveGraph));
    },
  });

  bb.agents.registerTool({
    name: "graph_studio_run",
    /**
     * The description is the only thing the calling model reads, so it says
     * the part that decides whether the run is any good: `input` is all the
     * graph will ever know. Its workers are fresh threads — they do not see
     * this conversation, its attachments or what was decided in it, and the
     * nodes after the first see only what the first one wrote. Everything has
     * to pass through here.
     */
    description:
      "Start a Graph Studio run: executes a stored graph whose nodes spawn BB threads. Supports cycles, conditional routing and human approval nodes.\n\nIMPORTANT: `input` is the only context the run gets. Its workers are fresh threads with no sight of this conversation, its attachments, or anything decided in it — and every node after the first reads only what the first one produced. So do not pass the user's last sentence: write out what the run needs to know. State the task, the constraints agreed here, what was already ruled out and why, and the paths of any files that matter (attachments included — quote what is relevant, workers cannot open them). Up to 8000 characters, and using them is usually right.",
    parameters: z.object({
      graphId: z.string(),
      input: z.string().min(1).max(8000),
    }),
    // The thread and project come from the call's own context. They used to be
    // a parameter, which asked the model for its own thread id: get it wrong
    // or leave it out and the run failed on "a run needs a parent thread" —
    // after the model had already written the input.
    execute: async ({ graphId, input }, ctx) => {
      const startedId = startRun({
        graphId,
        input,
        threadId: ctx.threadId,
        projectId: ctx.projectId,
      });
      return `Run ${startedId} started.`;
    },
  });

  // The chat's way to answer an approval the run posted into it. Without a
  // tool the agent would have to know the CLI, and a guessed command is how
  // an answer ends up nowhere.
  bb.agents.registerTool({
    name: "graph_studio_answer",
    description:
      "Answer a Graph Studio run that is waiting at a human approval node, and let it continue. Use it only with what the user decided — never approve or answer on your own. Pass the runId and nodeId from the approval message and the user's answer in their own words. If the approval was already answered elsewhere, the tool says so; tell the user instead of retrying.",
    parameters: z.object({
      runId: z.string(),
      nodeId: z.string().optional(),
      answer: z.string().min(1).max(4000),
    }),
    execute: async ({ runId, nodeId, answer }, ctx) => {
      const row = store.getRun(runId);
      if (!row) return `No run ${runId}.`;
      try {
        answerHuman(runId, answer, {
          source: answerSource(ctx.threadId, row.threadId),
          nodeId,
        });
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
      return `Answer taken; run ${runId} continues.`;
    },
  });

  bb.agents.registerTool({
    name: "graph_studio_status",
    description: "Read the state of a Graph Studio run, including per-node results.",
    parameters: z.object({ runId: z.string() }),
    execute: async ({ runId }) => {
      const dto = toDto(runId);
      if (!dto) return `No run ${runId}.`;
      const nodes = dto.nodeRuns
        .map((node) => `${node.nodeId}: ${node.status}`)
        .join(", ");
      return `${dto.id} is ${dto.status}. Nodes: ${nodes || "none yet"}.${
        dto.pendingQuestion ? ` Waiting for: ${dto.pendingQuestion.question}` : ""
      }`;
    },
  });

  // An open panel fetches the library once on mount and then only on a
  // realtime event. A reload changes the shipped templates under it without
  // producing one, so the panel keeps showing the previous list until it is
  // reopened — which looks exactly like the new template failing to load.
  // One publish on load closes that gap.
  publish();

  // A plugin reload leaves runs marked `running` with nobody driving them.
  // The checkpointer holds their position, so they can simply be resumed.
  bb.background.service("resume-orphans", {
    // Resumes once on load, then stays parked until the host aborts. A
    // service that returns early is reported as stopped, so the wait is what
    // keeps the plugin's status honest.
    start(signal: AbortSignal) {
      for (const row of store.listRunsByStatus("running")) {
        bb.log.info(`Resuming run ${row.id} after reload.`);
        void drive(row.id);
      }
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
}

export { START_NODE, END_NODE };
export type { Graph };
