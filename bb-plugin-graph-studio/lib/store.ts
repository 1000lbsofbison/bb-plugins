// Persistence: graphs, runs, and per-node attempts.
//
// One append-only migration list, per the SDK's rule that shipped statements
// are never reordered or edited.
import type { Database } from "better-sqlite3";
import { graphSchema, type Graph } from "./graph";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS graphs (
     id TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     graph_id TEXT NOT NULL,
     graph_json TEXT NOT NULL,
     thread_id TEXT,
     project_id TEXT,
     input TEXT NOT NULL,
     status TEXT NOT NULL,
     state_json TEXT NOT NULL,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS node_runs (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     status TEXT NOT NULL,
     child_thread_id TEXT,
     output TEXT,
     error TEXT,
     started_at INTEGER,
     ended_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS node_runs_by_run ON node_runs (run_id)`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
     thread_id TEXT NOT NULL,
     checkpoint_ns TEXT NOT NULL,
     checkpoint_id TEXT NOT NULL,
     parent_id TEXT,
     type TEXT,
     checkpoint BLOB NOT NULL,
     metadata BLOB NOT NULL,
     PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
   )`,
  `CREATE TABLE IF NOT EXISTS checkpoint_writes (
     thread_id TEXT NOT NULL,
     checkpoint_ns TEXT NOT NULL,
     checkpoint_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     channel TEXT NOT NULL,
     type TEXT,
     value BLOB,
     PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
   )`,
  // Appended, never inserted: migrations are applied by index, so a statement
  // squeezed into the middle would never run on a database that is already
  // past that point.
  //
  // Dialogue bookkeeping. LangGraph re-runs a node from the top after an
  // `interrupt()` and replays the earlier interrupts from the checkpoint — so
  // whatever the node did *before* them happens a second time. Spawning a
  // fresh worker thread per question is exactly that failure. This table is
  // what the replay recognises the open conversation by.
  `CREATE TABLE IF NOT EXISTS dialogs (
     run_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     visit INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     turns INTEGER NOT NULL,
     PRIMARY KEY (run_id, node_id, visit)
   )`,
  // What a node cost. Duration was always derivable from started_at/ended_at
  // and never shown; tokens come from the worker thread's own usage event,
  // read once the thread is idle. Nullable on purpose: a node whose usage
  // could not be read must read as "unbekannt", never as 0 — a zero here
  // would be a claim that the node was free.
  `ALTER TABLE node_runs ADD COLUMN input_tokens INTEGER`,
  `ALTER TABLE node_runs ADD COLUMN output_tokens INTEGER`,
];

export type RunStatus =
  | "running"
  | "waiting-human"
  | "done"
  | "failed"
  | "stopped";

export type NodeRunStatus = "running" | "done" | "failed" | "skipped";

export type RunRow = {
  id: string;
  graphId: string;
  graph: Graph;
  threadId: string | null;
  projectId: string | null;
  input: string;
  status: RunStatus;
  state: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type NodeRunRow = {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: NodeRunStatus;
  childThreadId: string | null;
  output: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Null = not read (yet), not "none". See the migration note. */
  inputTokens: number | null;
  outputTokens: number | null;
};

export function createStore(db: Database) {
  const listGraphsStmt = db.prepare(
    `SELECT json FROM graphs ORDER BY updated_at DESC`,
  );
  const getGraphStmt = db.prepare(`SELECT json FROM graphs WHERE id = ?`);
  const getCreatedAtStmt = db.prepare(
    `SELECT created_at FROM graphs WHERE id = ?`,
  );
  const upsertGraphStmt = db.prepare(
    `INSERT INTO graphs (id, json, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  );
  const deleteGraphStmt = db.prepare(`DELETE FROM graphs WHERE id = ?`);

  const insertRunStmt = db.prepare(
    `INSERT INTO runs (id, graph_id, graph_json, thread_id, project_id, input, status, state_json, error, created_at, updated_at)
     VALUES (@id, @graphId, @graphJson, @threadId, @projectId, @input, @status, @stateJson, @error, @createdAt, @updatedAt)`,
  );
  const updateRunStmt = db.prepare(
    `UPDATE runs SET status = @status, state_json = @stateJson, error = @error, updated_at = @updatedAt WHERE id = @id`,
  );
  const getRunStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  const listRunsStmt = db.prepare(
    `SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?`,
  );
  const listRunsByThreadStmt = db.prepare(
    `SELECT * FROM runs WHERE thread_id = ? ORDER BY updated_at DESC LIMIT ?`,
  );
  const listRunsByStatusStmt = db.prepare(
    `SELECT * FROM runs WHERE status = ?`,
  );

  const insertNodeRunStmt = db.prepare(
    `INSERT INTO node_runs (id, run_id, node_id, attempt, status, child_thread_id, output, error, started_at, ended_at)
     VALUES (@id, @runId, @nodeId, @attempt, @status, @childThreadId, @output, @error, @startedAt, @endedAt)`,
  );
  const updateNodeRunStmt = db.prepare(
    `UPDATE node_runs SET status = @status, child_thread_id = @childThreadId, output = @output, error = @error, ended_at = @endedAt,
       input_tokens = @inputTokens, output_tokens = @outputTokens WHERE id = @id`,
  );
  // Its own statement rather than a call to `updateNodeRun`: that one writes
  // status, output and ended_at in the same breath, and the worker's id is
  // known while the node is still running — using it here would close the row
  // the moment the thread was spawned.
  const attachThreadStmt = db.prepare(
    `UPDATE node_runs SET child_thread_id = @childThreadId WHERE id = @id`,
  );
  const listNodeRunsStmt = db.prepare(
    `SELECT * FROM node_runs WHERE run_id = ? ORDER BY started_at ASC, attempt ASC`,
  );
  const findRunningNodeRunStmt = db.prepare(
    `SELECT * FROM node_runs WHERE run_id = ? AND node_id = ? AND status = 'running'
     ORDER BY attempt DESC LIMIT 1`,
  );
  const countAttemptsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM node_runs WHERE run_id = ? AND node_id = ?`,
  );

  const getDialogStmt = db.prepare(
    `SELECT thread_id, turns FROM dialogs WHERE run_id = ? AND node_id = ? AND visit = ?`,
  );
  const listDialogsStmt = db.prepare(
    `SELECT node_id, thread_id FROM dialogs WHERE run_id = ? ORDER BY visit ASC`,
  );
  const upsertDialogStmt = db.prepare(
    `INSERT INTO dialogs (run_id, node_id, visit, thread_id, turns)
     VALUES (@runId, @nodeId, @visit, @threadId, @turns)
     ON CONFLICT(run_id, node_id, visit) DO UPDATE SET turns = excluded.turns`,
  );

  const toRun = (row: Record<string, unknown>): RunRow => ({
    id: row.id as string,
    graphId: row.graph_id as string,
    graph: graphSchema.parse(JSON.parse(row.graph_json as string)),
    threadId: (row.thread_id as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    input: row.input as string,
    status: row.status as RunStatus,
    state: JSON.parse(row.state_json as string),
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  });

  const toNodeRun = (row: Record<string, unknown>): NodeRunRow => ({
    id: row.id as string,
    runId: row.run_id as string,
    nodeId: row.node_id as string,
    attempt: row.attempt as number,
    status: row.status as NodeRunStatus,
    childThreadId: (row.child_thread_id as string | null) ?? null,
    output: (row.output as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    startedAt: (row.started_at as number | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
    inputTokens: (row.input_tokens as number | null) ?? null,
    outputTokens: (row.output_tokens as number | null) ?? null,
  });

  return {
    listGraphs(): Graph[] {
      return (listGraphsStmt.all() as Array<{ json: string }>).flatMap((row) => {
        const parsed = graphSchema.safeParse(JSON.parse(row.json));
        return parsed.success ? [parsed.data] : [];
      });
    },
    getGraph(id: string): Graph | null {
      const row = getGraphStmt.get(id) as { json: string } | undefined;
      if (!row) return null;
      const parsed = graphSchema.safeParse(JSON.parse(row.json));
      return parsed.success ? parsed.data : null;
    },
    /**
     * `createdAt` is owned by the row, not by the caller: a graph round-tripped
     * through the schema comes back with the default 0, which would otherwise
     * silently reset the creation date on every save.
     */
    saveGraph(graph: Graph, now: number): Graph {
      const existing = getCreatedAtStmt.get(graph.id) as
        | { created_at: number }
        | undefined;
      const createdAt = existing?.created_at ?? (graph.createdAt || now);
      const next = { ...graph, createdAt, updatedAt: now };
      upsertGraphStmt.run(next.id, JSON.stringify(next), createdAt, now);
      return next;
    },
    deleteGraph(id: string) {
      deleteGraphStmt.run(id);
    },

    insertRun(row: RunRow) {
      insertRunStmt.run({
        id: row.id,
        graphId: row.graphId,
        graphJson: JSON.stringify(row.graph),
        threadId: row.threadId,
        projectId: row.projectId,
        input: row.input,
        status: row.status,
        stateJson: JSON.stringify(row.state),
        error: row.error,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    },
    updateRun(
      id: string,
      patch: { status: RunStatus; state: unknown; error: string | null },
      now: number,
    ) {
      updateRunStmt.run({
        id,
        status: patch.status,
        stateJson: JSON.stringify(patch.state),
        error: patch.error,
        updatedAt: now,
      });
    },
    getRun(id: string): RunRow | null {
      const row = getRunStmt.get(id) as Record<string, unknown> | undefined;
      return row ? toRun(row) : null;
    },
    listRuns(limit = 50): RunRow[] {
      return (listRunsStmt.all(limit) as Array<Record<string, unknown>>).map(toRun);
    },
    listRunsByThread(threadId: string, limit = 20): RunRow[] {
      return (
        listRunsByThreadStmt.all(threadId, limit) as Array<Record<string, unknown>>
      ).map(toRun);
    },
    listRunsByStatus(status: RunStatus): RunRow[] {
      return (
        listRunsByStatusStmt.all(status) as Array<Record<string, unknown>>
      ).map(toRun);
    },

    insertNodeRun(row: NodeRunRow) {
      insertNodeRunStmt.run(row);
    },
    updateNodeRun(
      id: string,
      patch: {
        status: NodeRunStatus;
        childThreadId: string | null;
        output: string | null;
        error: string | null;
        endedAt: number | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
      },
    ) {
      updateNodeRunStmt.run({
        inputTokens: null,
        outputTokens: null,
        id,
        ...patch,
      });
    },
    /**
     * The worker this attempt is running in, recorded while it runs. Without
     * it the inspector can only offer the thread link once the node is done —
     * which is precisely the moment nobody needs it any more.
     */
    attachThread(id: string, childThreadId: string) {
      attachThreadStmt.run({ id, childThreadId });
    },
    /** Rows so far for this node — the next attempt's number. */
    countAttempts(runId: string, nodeId: string): number {
      return (countAttemptsStmt.get(runId, nodeId) as { n: number }).n;
    },
    /** The attempt still open for this node, if any. */
    findRunningNodeRun(runId: string, nodeId: string): NodeRunRow | null {
      const row = findRunningNodeRunStmt.get(runId, nodeId) as
        | Record<string, unknown>
        | undefined;
      return row ? toNodeRun(row) : null;
    },
    /** The conversation a dialogue node already opened for this visit. */
    getDialog(
      runId: string,
      nodeId: string,
      visit: number,
    ): { threadId: string; turns: number } | null {
      const row = getDialogStmt.get(runId, nodeId, visit) as
        | { thread_id: string; turns: number }
        | undefined;
      return row ? { threadId: row.thread_id, turns: row.turns } : null;
    },
    saveDialog(
      runId: string,
      nodeId: string,
      visit: number,
      session: { threadId: string; turns: number },
    ) {
      upsertDialogStmt.run({
        runId,
        nodeId,
        visit,
        threadId: session.threadId,
        turns: session.turns,
      });
    },
    /** Every dialogue thread this run opened, whatever became of its node. */
    listDialogs(runId: string): Array<{ nodeId: string; threadId: string }> {
      return (
        listDialogsStmt.all(runId) as Array<{ node_id: string; thread_id: string }>
      ).map((row) => ({ nodeId: row.node_id, threadId: row.thread_id }));
    },
    listNodeRuns(runId: string): NodeRunRow[] {
      return (
        listNodeRunsStmt.all(runId) as Array<Record<string, unknown>>
      ).map(toNodeRun);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
