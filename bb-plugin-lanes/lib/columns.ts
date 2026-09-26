// The six columns, and the rule for putting a task in one of them.
//
// Pure on purpose: this is the only place that decides where a card lands, and
// it has to stay testable without a database or a DOM.

/** The statuses `tasks.status` is CHECK-constrained to, in board order. */
export const LANE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;

export type LaneStatus = (typeof LANE_STATUSES)[number];

/**
 * Where a status the plugin does not know about lands. Impossible today given
 * the CHECK constraint, possible after a Tasks migration — and a card that
 * belongs to no column would otherwise disappear from the board without a
 * trace, which is the one failure mode a board must not have.
 */
export const UNKNOWN_COLUMN_ID = "unknown";

export const COLUMN_TITLES: Record<LaneStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

/**
 * Collapsed by default. A board whose right edge is a growing pile of finished
 * work stops being a board.
 */
export const COLLAPSED_BY_DEFAULT: readonly LaneStatus[] = ["done", "canceled"];

export function isLaneStatus(value: unknown): value is LaneStatus {
  return (
    typeof value === "string" &&
    (LANE_STATUSES as readonly string[]).includes(value)
  );
}

export type BoardTask = {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  position: number;
  labels: { name: string; color: string }[];
  /** True while at least one attached agent thread is starting or working. */
  liveThread: boolean;
};

export type BoardColumn = {
  id: string;
  title: string;
  /** `null` for the unknown-status column, which no card can be moved into. */
  status: LaneStatus | null;
  collapsedByDefault: boolean;
  tasks: BoardTask[];
};

/**
 * Groups tasks into the six columns, preserving the `position` order the Tasks
 * app assigned. The six known columns always exist, empty or not — an empty
 * column is a drop target, so hiding it would remove the only way to move the
 * first card into it. The unknown column is the exception: it appears only when
 * something is actually in it.
 */
export function groupIntoColumns(tasks: readonly BoardTask[]): BoardColumn[] {
  const byStatus = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    const bucket = isLaneStatus(task.status) ? task.status : UNKNOWN_COLUMN_ID;
    const list = byStatus.get(bucket);
    if (list) list.push(task);
    else byStatus.set(bucket, [task]);
  }

  const sort = (list: BoardTask[]) =>
    // `position` is a REAL and may tie after a migration; the key is a stable
    // tie-break so the board does not reshuffle between two identical reads.
    [...list].sort(
      (left, right) =>
        left.position - right.position || left.key.localeCompare(right.key),
    );

  const columns: BoardColumn[] = LANE_STATUSES.map((status) => ({
    id: status,
    title: COLUMN_TITLES[status],
    status,
    collapsedByDefault: COLLAPSED_BY_DEFAULT.includes(status),
    tasks: sort(byStatus.get(status) ?? []),
  }));

  const unknown = byStatus.get(UNKNOWN_COLUMN_ID);
  if (unknown && unknown.length > 0) {
    columns.push({
      id: UNKNOWN_COLUMN_ID,
      title: "Unknown status",
      status: null,
      collapsedByDefault: false,
      tasks: sort(unknown),
    });
  }

  return columns;
}
