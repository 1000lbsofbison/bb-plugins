// Reading the `tasks` plugin's database — read-only, and treated as a foreign
// schema throughout.
//
// The path is NOT `~/.bb`. `bb.experimental_dataDir` is the supported way to
// learn where this server keeps `plugins/<id>/`, and the SDK spells out why
// guessing is wrong: a dev server derives its data dir from the repo root and
// an instance id, so a plugin that hardcodes `~/.bb` reads the production
// database while the server it runs in reads another one.
//
// Every function here takes an open handle rather than a path, so the tests can
// hand it a temporary file built from the real schema.
import type { Database } from "better-sqlite3";

/**
 * The highest `schema_version` row this plugin was built against, measured from
 * the installed `tasks` plugin's database on 2026-09-19 (rows 1..6).
 *
 * Reading a table someone else migrated past this point would mean silently
 * misreporting the board, so a higher version is refused with a message rather
 * than guessed at.
 */
export const SUPPORTED_SCHEMA_VERSION = 6;

/** Where the tasks plugin keeps its database, relative to BB's data dir. */
export function tasksDatabasePath(dataDir: string): string {
  return `${dataDir}/plugins/tasks/data.db`;
}

/**
 * The applied migration id, i.e. the highest row in `schema_version`. A missing
 * table or an empty one reads as 0 — a database that is not the one we expect
 * is refused by the same path as one that is too new.
 */
export function readSchemaVersion(db: Database): number {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    )
    .get();
  if (table === undefined) return 0;
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_version")
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

/**
 * The change counter the `tasks` plugin's triggers bump on every insert, update
 * and delete. Reading it costs one row; refetching the board only when it moved
 * is the whole reason reading SQLite directly is worth it.
 */
export function readRevision(db: Database): number {
  const row = db
    .prepare("SELECT revision FROM task_list_revision WHERE id = 1")
    .get() as { revision: number } | undefined;
  return row?.revision ?? 0;
}

export type TrackerProject = {
  id: string;
  name: string;
  prefix: string;
  color: string;
  /** The BB project this tracker project is bound to, when it is bound at all. */
  linkedBbProjectId: string | null;
};

export function readProjects(db: Database): TrackerProject[] {
  const rows = db
    .prepare(
      `SELECT id, name, prefix, color, linked_bb_project_id
         FROM projects
        ORDER BY name COLLATE NOCASE`,
    )
    .all() as {
    id: string;
    name: string;
    prefix: string;
    color: string;
    linked_bb_project_id: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    color: row.color,
    linkedBbProjectId: row.linked_bb_project_id,
  }));
}

export type TaskRow = {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  position: number;
  labels: { name: string; color: string }[];
  liveThread: boolean;
};

/**
 * Live means the agent is still going — `starting` or `working`. `idle`,
 * `completed` and `failed` are threads that have stopped, and a permanent dot
 * on every card a thread ever touched says nothing.
 */
const LIVE_THREAD_STATUSES = ["starting", "working"] as const;

/**
 * Every task of one tracker project, with its labels and whether a live agent
 * thread is attached. One statement rather than one per card: a board of a
 * hundred tasks would otherwise be a few hundred round trips per poll.
 *
 * `position` is read but not sorted on here — `groupIntoColumns` owns the
 * order, and it needs the same rule in the tests that have no database.
 */
export function readTasks(db: Database, projectId: string): TaskRow[] {
  const rows = db
    .prepare(
      `SELECT t.id          AS id,
              p.prefix      AS prefix,
              t.number      AS number,
              t.title       AS title,
              t.status      AS status,
              t.priority    AS priority,
              t.position    AS position,
              EXISTS (
                SELECT 1 FROM task_threads th
                 WHERE th.task_id = t.id
                   AND th.live_status IN (${LIVE_THREAD_STATUSES.map(() => "?").join(", ")})
              )             AS live_thread
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE t.project_id = ?`,
    )
    .all(...LIVE_THREAD_STATUSES, projectId) as {
    id: string;
    prefix: string;
    number: number;
    title: string;
    status: string;
    priority: string;
    position: number;
    live_thread: number;
  }[];

  const labels = readLabelsByTask(db, projectId);

  return rows.map((row) => ({
    id: row.id,
    key: `${row.prefix}-${row.number}`,
    title: row.title,
    status: row.status,
    priority: row.priority,
    position: row.position,
    labels: labels.get(row.id) ?? [],
    liveThread: row.live_thread === 1,
  }));
}

function readLabelsByTask(
  db: Database,
  projectId: string,
): Map<string, { name: string; color: string }[]> {
  const rows = db
    .prepare(
      `SELECT tl.task_id AS task_id, l.name AS name, l.color AS color
         FROM task_labels tl
         JOIN labels l ON l.id = tl.label_id
         JOIN tasks t  ON t.id = tl.task_id
        WHERE t.project_id = ?
        ORDER BY l.name COLLATE NOCASE`,
    )
    .all(projectId) as { task_id: string; name: string; color: string }[];

  const byTask = new Map<string, { name: string; color: string }[]>();
  for (const row of rows) {
    const list = byTask.get(row.task_id);
    const label = { name: row.name, color: row.color };
    if (list) list.push(label);
    else byTask.set(row.task_id, [label]);
  }
  return byTask;
}
