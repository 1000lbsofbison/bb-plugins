// bb-plugin-lanes — backend.
//
// The one decision this plugin rests on is asymmetric: read straight from the
// `tasks` plugin's SQLite file, write through `bb tasks update`. Reading is
// cheap and gives us `task_list_revision`, a counter the tasks plugin's own
// triggers bump — change detection costs a single row instead of spawning a
// CLI process on a timer to learn that nothing happened. Writing through the
// CLI keeps that plugin's invariants where they belong.
//
// On the two questions the concept left open, measured against
// @get-bb/plugin-sdk 0.4.84:
//
//   * There is no API for another plugin's data directory. `bb.storage` is
//     scoped to this plugin, and `experimental_paths.dataDir` (host entry) is
//     too. `bb.server.experimental_dataDir` is BB's own data dir, documented as
//     being "for reading bb-managed files" — so the path is built from it, and
//     never from `~/.bb`. It is bind-gated: read it from a handler, not at load.
//   * There is no task event. `bb.events.on` takes a `PluginThreadEventName`,
//     and the whole union is thread, turn, interaction and queued-message
//     lifecycle — nothing about tasks. Polling the revision stands.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
// better-sqlite3 is a native module the host supplies — the SDK lists it as a
// peer dependency and `bb plugin build` keeps it external, so this import is a
// reference to the host's copy, not a second one inside the bundle.
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { z } from "zod";
import {
  LANE_STATUSES,
  groupIntoColumns,
  type BoardColumn,
} from "./lib/columns";
import {
  SUPPORTED_SCHEMA_VERSION,
  readProjects,
  readRevision,
  readSchemaVersion,
  readTasks,
  tasksDatabasePath,
} from "./lib/tasks-db";
import { buildUpdateStatusArgs, runBbCli } from "./lib/tasks-cli";

const projectId = z.string().min(1).max(200);

const labelSchema = z.object({ name: z.string(), color: z.string() });

const taskSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  position: z.number(),
  labels: z.array(labelSchema),
  liveThread: z.boolean(),
});

const columnSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(LANE_STATUSES).nullable(),
  collapsedByDefault: z.boolean(),
  tasks: z.array(taskSchema),
});

/**
 * Every read answers with the same three shapes, so the frontend has one place
 * to handle "no database yet" and "schema moved on" instead of a special case
 * per call.
 */
const unavailableSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }),
  z.object({
    kind: z.literal("unsupported-schema"),
    found: z.number(),
    supported: z.number(),
  }),
]);

export const rpcContract = defineRpcContract({
  /** Tracker projects to choose between, plus whatever stopped us reading. */
  board_projects: {
    input: z.null(),
    output: z.object({
      unavailable: unavailableSchema.nullable(),
      projects: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          prefix: z.string(),
          color: z.string(),
          linkedBbProjectId: z.string().nullable(),
        }),
      ),
    }),
  },

  /** One project's board, with the revision it was read at. */
  board_load: {
    input: z.object({ projectId }),
    output: z.object({
      unavailable: unavailableSchema.nullable(),
      revision: z.number(),
      columns: z.array(columnSchema),
    }),
  },

  /**
   * The poll. Separate from `board_load` because that is the entire point of
   * reading SQLite directly: one row, and the columns are refetched only when
   * the number moved.
   */
  board_revision: {
    input: z.null(),
    output: z.object({
      unavailable: unavailableSchema.nullable(),
      revision: z.number(),
    }),
  },

  /**
   * Moving a card between columns. The only write this plugin has, and it
   * shells out — see lib/tasks-cli.ts.
   */
  task_set_status: {
    input: z.object({
      taskKey: z.string().min(1).max(100),
      status: z.enum(LANE_STATUSES),
    }),
    output: z.object({ ok: z.boolean() }),
  },
});

export type BoardColumnDto = BoardColumn;

/** Realtime channel: one write, every open board follows without waiting for its poll. */
const CHANGED = "lanes-changed";

type Unavailable = z.infer<typeof unavailableSchema>;

export default async function plugin(bb: BbPluginApi) {
  // The handle is cached for the plugin's lifetime: opening SQLite per poll
  // would undo the cheapness that made polling acceptable in the first place.
  let handle: Database | null = null;

  function open(): Database | Unavailable {
    if (handle !== null) return handle;

    const path = tasksDatabasePath(bb.server.experimental_dataDir);
    let db: Database;
    try {
      db = new DatabaseConstructor(path, {
        // Read-only is the contract with the other plugin, enforced by SQLite
        // rather than by our own discipline.
        readonly: true,
        fileMustExist: true,
      });
    } catch (cause) {
      bb.log.info(`tasks database not readable at ${path}: ${String(cause)}`);
      return { kind: "missing" };
    }

    const version = readSchemaVersion(db);
    if (version === 0 || version > SUPPORTED_SCHEMA_VERSION) {
      db.close();
      return version === 0
        ? { kind: "missing" }
        : {
            kind: "unsupported-schema",
            found: version,
            supported: SUPPORTED_SCHEMA_VERSION,
          };
    }

    handle = db;
    return handle;
  }

  function isUnavailable(value: Database | Unavailable): value is Unavailable {
    return "kind" in value;
  }

  bb.rpc.register(rpcContract, {
    board_projects: async () => {
      const db = open();
      if (isUnavailable(db)) return { unavailable: db, projects: [] };
      return { unavailable: null, projects: readProjects(db) };
    },

    board_load: async ({ projectId: id }) => {
      const db = open();
      if (isUnavailable(db)) {
        return { unavailable: db, revision: 0, columns: [] };
      }
      // Revision first: read after the rows, a write landing in between would
      // hand back a stale board stamped with the new number, and the poll would
      // never ask again.
      const revision = readRevision(db);
      const columns = groupIntoColumns(readTasks(db, id));
      return { unavailable: null, revision, columns };
    },

    board_revision: async () => {
      const db = open();
      if (isUnavailable(db)) return { unavailable: db, revision: 0 };
      return { unavailable: null, revision: readRevision(db) };
    },

    task_set_status: async ({ taskKey, status }) => {
      await runBbCli(buildUpdateStatusArgs(taskKey, status));
      bb.realtime.publish(CHANGED, { kind: "status", taskKey });
      return { ok: true };
    },
  });

  bb.log.info("lanes loaded");
}
