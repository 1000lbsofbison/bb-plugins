// The board itself — presentation only.
//
// Split from `board.tsx` so the render conditions can be tested without RPC:
// the live-thread dot, the refusal message and the unknown-status column are
// exactly the rules that fail silently when they fail.
import { useState } from "react";
import type { BoardColumn, LaneStatus } from "@/lib/columns";
import { LANE_STATUSES } from "@/lib/columns";

export type Unavailable =
  | { kind: "missing" }
  | { kind: "unsupported-schema"; found: number; supported: number };

export type BoardViewProps = {
  columns: BoardColumn[];
  unavailable: Unavailable | null;
  /** Rejected by the caller for the unknown-status column, which has no status. */
  onMove: (taskKey: string, status: LaneStatus) => void;
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "",
};

function UnavailableNotice({ reason }: { reason: Unavailable }) {
  // A plain message, not a crash, and not a board rendered from a schema we do
  // not understand: silently misreading someone else's migrated table is worse
  // than saying nothing.
  const text =
    reason.kind === "missing"
      ? "No Tasks database found. Install and open the Tasks plugin first — Lanes shows its records, it does not keep any of its own."
      : `The Tasks database is at schema version ${reason.found}, and Lanes was built against ${reason.supported}. Update Lanes rather than trusting a board read from a schema it does not know.`;

  return (
    <div role="alert" className="m-4 rounded-md border p-4 text-sm">
      {text}
    </div>
  );
}

/** The next known column in the given direction, or null at either edge. */
function neighbourStatus(
  status: LaneStatus | null,
  direction: -1 | 1,
): LaneStatus | null {
  if (status === null) {
    // A card with an unrecognised status has no neighbours to speak of, but it
    // must still be movable out of the unknown column — so both directions land
    // on the nearest real one.
    return direction === -1
      ? LANE_STATUSES[0]
      : LANE_STATUSES[LANE_STATUSES.length - 1];
  }
  const next = LANE_STATUSES.indexOf(status) + direction;
  return next >= 0 && next < LANE_STATUSES.length ? LANE_STATUSES[next] : null;
}

export function BoardView({ columns, unavailable, onMove }: BoardViewProps) {
  // Only the columns the user has toggled. Seeding this from `columns` on first
  // render would lose the defaults entirely: the first render happens before
  // the board has loaded, when there are no columns to read them from.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<string | null>(null);

  if (unavailable !== null) return <UnavailableNotice reason={unavailable} />;

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3" data-testid="board">
      {columns.map((column) => {
        const isCollapsed = toggled[column.id] ?? column.collapsedByDefault;
        return (
          <section
            key={column.id}
            aria-label={column.title}
            data-testid={`column-${column.id}`}
            className={`flex shrink-0 flex-col rounded-md border ${isCollapsed ? "w-12" : "w-64"}`}
            onDragOver={(event) => {
              // Only a droppable column may preventDefault — doing it
              // unconditionally would show a drop cursor over the unknown
              // column, where the drop cannot be persisted.
              if (column.status !== null) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (column.status === null || dragging === null) return;
              onMove(dragging, column.status);
              setDragging(null);
            }}
          >
            <button
              type="button"
              aria-expanded={!isCollapsed}
              className="flex items-center justify-between gap-2 p-2 text-sm font-medium"
              onClick={() =>
                setToggled((previous) => ({
                  ...previous,
                  [column.id]: !isCollapsed,
                }))
              }
            >
              <span className={isCollapsed ? "sr-only" : undefined}>
                {column.title}
              </span>
              <span className="text-xs opacity-60">{column.tasks.length}</span>
            </button>

            {!isCollapsed && (
              <ul className="flex flex-col gap-2 overflow-y-auto p-2">
                {column.tasks.map((task) => (
                  <li key={task.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      draggable
                      data-testid={`card-${task.key}`}
                      className="rounded-md border p-2 text-sm"
                      onDragStart={() => setDragging(task.key)}
                      onDragEnd={() => setDragging(null)}
                      onKeyDown={(event) => {
                        // The keyboard path for the same move. A board
                        // reachable only by pointer excludes the case where a
                        // card is three columns away.
                        if (!event.altKey) return;
                        const direction =
                          event.key === "ArrowLeft"
                            ? -1
                            : event.key === "ArrowRight"
                              ? 1
                              : null;
                        if (direction === null) return;
                        const target = neighbourStatus(column.status, direction);
                        if (target === null) return;
                        event.preventDefault();
                        onMove(task.key, target);
                      }}
                    >
                      <div className="flex items-center gap-1 text-xs opacity-60">
                        <span>{task.key}</span>
                        {task.liveThread && (
                          <span
                            data-testid={`live-${task.key}`}
                            aria-label="Agent thread running"
                            title="Agent thread running"
                          >
                            ●
                          </span>
                        )}
                        {PRIORITY_LABELS[task.priority] && (
                          <span>{PRIORITY_LABELS[task.priority]}</span>
                        )}
                      </div>
                      <div>{task.title}</div>
                      {task.labels.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1 text-xs">
                          {task.labels.map((label) => (
                            <span
                              key={label.name}
                              className="rounded px-1"
                              style={{ backgroundColor: label.color }}
                            >
                              {label.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
