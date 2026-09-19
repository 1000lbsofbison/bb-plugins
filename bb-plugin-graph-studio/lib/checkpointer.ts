// A LangGraph checkpointer over the plugin's own SQLite handle.
//
// Why not `@langchain/langgraph-checkpoint-sqlite`: that package bundles its
// own better-sqlite3, and a native module inside a single-file plugin bundle
// is the one thing most likely to break. The host already hands us an open,
// WAL-mode better-sqlite3 handle through `bb.storage.database()`, so the
// checkpointer is ~100 lines of pure JS over a handle we already own.
//
// This is what makes a run durable: a plugin reload mid-run resumes from the
// last checkpoint instead of losing the graph's position.
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Database } from "better-sqlite3";

type Row = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_id: string | null;
  type: string | null;
  checkpoint: Buffer;
  metadata: Buffer;
};

type WriteRow = {
  task_id: string;
  channel: string;
  type: string | null;
  value: Buffer | null;
};

export class SqliteCheckpointer extends BaseCheckpointSaver {
  private readonly db: Database;

  constructor(db: Database, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
  }

  private static ids(config: RunnableConfig) {
    const configurable = (config.configurable ?? {}) as Record<string, unknown>;
    return {
      threadId: String(configurable.thread_id ?? ""),
      ns: String(configurable.checkpoint_ns ?? ""),
      id: configurable.checkpoint_id as string | undefined,
    };
  }

  private async toTuple(row: Row): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint,
    )) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.metadata,
    )) as CheckpointMetadata;

    const writeRows = this.db
      .prepare(
        `SELECT task_id, channel, type, value FROM checkpoint_writes
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         ORDER BY task_id, idx`,
      )
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as WriteRow[];

    const pendingWrites = await Promise.all(
      writeRows.map(async (write) => {
        const value = write.value
          ? await this.serde.loadsTyped(write.type ?? "json", write.value)
          : null;
        return [write.task_id, write.channel, value] as [string, string, unknown];
      }),
    );

    return {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      parentConfig: row.parent_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, ns, id } = SqliteCheckpointer.ids(config);
    const row = (
      id
        ? this.db
            .prepare(
              `SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
            )
            .get(threadId, ns, id)
        : this.db
            .prepare(
              `SELECT * FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?
               ORDER BY checkpoint_id DESC LIMIT 1`,
            )
            .get(threadId, ns)
    ) as Row | undefined;
    return row ? this.toTuple(row) : undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { threadId, ns } = SqliteCheckpointer.ids(config);
    const before = options?.before?.configurable?.checkpoint_id as
      | string
      | undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
           AND (? IS NULL OR checkpoint_id < ?)
         ORDER BY checkpoint_id DESC
         LIMIT ?`,
      )
      .all(threadId, ns, before ?? null, before ?? null, options?.limit ?? 100) as Row[];
    for (const row of rows) yield await this.toTuple(row);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const { threadId, ns, id } = SqliteCheckpointer.ids(config);
    const [type, serialisedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    const [, serialisedMetadata] = await this.serde.dumpsTyped(metadata);

    this.db
      .prepare(
        `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id)
         DO UPDATE SET checkpoint = excluded.checkpoint, metadata = excluded.metadata`,
      )
      .run(
        threadId,
        ns,
        checkpoint.id,
        id ?? null,
        type,
        Buffer.from(serialisedCheckpoint),
        Buffer.from(serialisedMetadata),
      );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const { threadId, ns, id } = SqliteCheckpointer.ids(config);
    if (!id) return;
    const statement = this.db.prepare(
      `INSERT INTO checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
       DO UPDATE SET channel = excluded.channel, type = excluded.type, value = excluded.value`,
    );
    for (const [index, [channel, value]] of writes.entries()) {
      const [type, serialised] = await this.serde.dumpsTyped(value);
      statement.run(
        threadId,
        ns,
        id,
        taskId,
        index,
        channel,
        type,
        Buffer.from(serialised),
      );
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(threadId);
    this.db
      .prepare(`DELETE FROM checkpoint_writes WHERE thread_id = ?`)
      .run(threadId);
  }
}
