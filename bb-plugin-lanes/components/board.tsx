// The board's data path: project picker, poll, move.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/server";
import type { BoardColumn, LaneStatus } from "@/lib/columns";
import { BoardView, type Unavailable } from "@/components/board-view";

/**
 * How often the revision row is read. One row per tick, so the cost is a
 * SELECT rather than a CLI process; the board itself is refetched only when the
 * number moved.
 */
const POLL_MS = 1_500;

type Project = {
  id: string;
  name: string;
  prefix: string;
  color: string;
  linkedBbProjectId: string | null;
};

export function Board() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held in a ref, not in state: the poll compares against it every tick and a
  // re-render per comparison would defeat the point of the cheap check.
  const revision = useRef<number | null>(null);

  useEffect(() => {
    void rpc.call("board_projects", null).then(
      (result) => {
        setUnavailable(result.unavailable);
        setProjects(result.projects);
        setProjectId((current) => current ?? result.projects[0]?.id ?? null);
      },
      (cause: unknown) => setError(String(cause)),
    );
  }, [rpc]);

  const reload = useCallback(() => {
    if (projectId === null) return;
    void rpc.call("board_load", { projectId }).then(
      (result) => {
        setUnavailable(result.unavailable);
        setColumns(result.columns as BoardColumn[]);
        revision.current = result.revision;
      },
      (cause: unknown) => setError(String(cause)),
    );
  }, [rpc, projectId]);

  // A fresh project means the held revision belongs to nothing.
  useEffect(() => {
    revision.current = null;
    reload();
  }, [reload]);

  useEffect(() => {
    if (projectId === null) return;
    const timer = setInterval(() => {
      void rpc.call("board_revision", null).then(
        (result) => {
          if (result.unavailable !== null) return;
          if (revision.current === result.revision) return;
          reload();
        },
        // A failed poll must not put an error in the way of a board that is
        // already on screen; the next tick tries again.
        () => {},
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [rpc, projectId, reload]);

  // Our own writes do not need to wait for the next tick.
  useRealtime("lanes-changed", reload);

  const move = useCallback(
    (taskKey: string, status: LaneStatus) => {
      setError(null);
      void rpc.call("task_set_status", { taskKey, status }).then(
        () => reload(),
        // The card stays where the database has it. Reporting the failure and
        // leaving the board honest beats an optimistic move that reverts on the
        // next poll with no explanation.
        (cause: unknown) => setError(String(cause)),
      );
    },
    [rpc, reload],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-2 text-sm">
        <label htmlFor="lanes-project">Project</label>
        <select
          id="lanes-project"
          className="rounded border px-1 py-0.5"
          value={projectId ?? ""}
          onChange={(event) => setProjectId(event.target.value || null)}
        >
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {error !== null && (
          <span role="alert" className="text-xs opacity-80">
            {error}
          </span>
        )}
      </div>
      <BoardView
        columns={columns}
        unavailable={unavailable}
        onMove={move}
      />
    </div>
  );
}
