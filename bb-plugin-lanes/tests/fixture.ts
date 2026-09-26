// A real SQLite file built from the `tasks` plugin's real schema.
//
// Not hand-written row objects: the schema is the contract with another plugin,
// and a mock cannot break when that contract does. `tasks-schema.sql` is the
// output of `.schema` against the installed plugin's database, so a CHECK
// constraint that changes upstream fails these tests instead of passing them.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseConstructor, { type Database } from "better-sqlite3";

const SCHEMA_PATH = fileURLToPath(
  new URL("./fixtures/tasks-schema.sql", import.meta.url),
);

export const FIXTURE_SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6];

export type Fixture = {
  db: Database;
  path: string;
  close: () => void;
};

/**
 * @param schemaVersions which `schema_version` rows to insert. The default is
 * what the plugin supports; a test that wants the refusal path passes a higher
 * one.
 */
export function createTasksFixture(
  schemaVersions: number[] = FIXTURE_SCHEMA_VERSIONS,
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "lanes-fixture-"));
  const path = join(dir, "data.db");
  const db = new DatabaseConstructor(path);
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));

  const applied = db.prepare(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
  );
  for (const version of schemaVersions) applied.run(version, "2026-09-19");
  db.prepare("INSERT INTO task_list_revision (id, revision) VALUES (1, 0)").run();

  return {
    db,
    path,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertProject(
  db: Database,
  values: { id: string; name: string; prefix: string },
): void {
  db.prepare(
    `INSERT INTO projects (id, name, prefix, color, created_at)
     VALUES (?, ?, ?, '#888888', '2026-09-19')`,
  ).run(values.id, values.name, values.prefix);
}

export function insertTask(
  db: Database,
  values: {
    id: string;
    projectId: string;
    number: number;
    title: string;
    status?: string;
    priority?: string;
    position?: number;
  },
): void {
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, number, title, status, priority, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-19', '2026-09-19')`,
  ).run(
    values.id,
    values.projectId,
    values.number,
    values.title,
    values.status ?? "todo",
    values.priority ?? "none",
    values.position ?? 1,
  );
}

export function attachThread(
  db: Database,
  values: { id: string; taskId: string; threadId: string; liveStatus: string },
): void {
  db.prepare(
    `INSERT INTO task_threads
       (id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at)
     VALUES (?, ?, ?, 'default', 'Worker', ?, '2026-09-19', '2026-09-19')`,
  ).run(values.id, values.taskId, values.threadId, values.liveStatus);
}

export function addLabel(
  db: Database,
  values: {
    id: string;
    projectId: string;
    taskId: string;
    name: string;
    color?: string;
  },
): void {
  db.prepare(
    "INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)",
  ).run(values.id, values.projectId, values.name, values.color ?? "#aabbcc");
  db.prepare(
    "INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)",
  ).run(values.taskId, values.id);
}
