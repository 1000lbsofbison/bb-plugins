// The run as a sequence: one tick per node visit, in the order they started,
// and the points it can be restarted from.
//
// The canvas says where the work stands; it cannot say in which order it got
// there, and on a graph with cycles that order is the story. Restart points
// used to be a separate folded list under everything else — here they sit on
// the same strip, next to the visits they come before.
import type { NodeRunDto } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type TimelineCheckpoint = {
  checkpointId: string;
  next: string[];
  doneCount: number;
};

const TICK_CLASS: Record<NodeRunDto["status"], string> = {
  running: "border-primary bg-primary/15 text-foreground",
  done: "border-border bg-card text-foreground",
  failed: "border-destructive bg-destructive/10 text-destructive",
  skipped: "border-dashed border-border text-muted-foreground",
};

export function RunTimeline({
  nodeRuns,
  checkpoints,
  label,
  selectedAttemptId,
  onSelectAttempt,
  onRestart,
  pending,
}: {
  nodeRuns: NodeRunDto[];
  checkpoints: TimelineCheckpoint[];
  label: (nodeId: string) => string;
  selectedAttemptId: string | null;
  onSelectAttempt: (attempt: NodeRunDto) => void;
  onRestart: (checkpointId: string) => void;
  pending: boolean;
}) {
  const ordered = [...nodeRuns].sort(
    (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  if (ordered.length === 0 && checkpoints.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {ordered.length > 0 ? (
        <ol
          aria-label="Run timeline"
          className="flex gap-1 overflow-x-auto pb-1 text-[11px]"
        >
          {ordered.map((attempt, index) => (
            <li key={attempt.id} className="flex shrink-0 items-center gap-1">
              {index > 0 ? (
                <Icon name="ChevronRight" className="size-3 text-muted-foreground" />
              ) : null}
              <button
                type="button"
                onClick={() => onSelectAttempt(attempt)}
                aria-pressed={selectedAttemptId === attempt.id}
                aria-label={`${label(attempt.nodeId)}, attempt ${attempt.attempt}, ${attempt.status}`}
                className={cn(
                  "rounded-full border px-2 py-0.5",
                  TICK_CLASS[attempt.status],
                  selectedAttemptId === attempt.id && "ring-2 ring-primary/60",
                )}
              >
                {label(attempt.nodeId)}
                {attempt.attempt > 1 ? (
                  <span className="text-muted-foreground"> #{attempt.attempt}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {checkpoints.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span
            className="text-muted-foreground"
            title="Continues the run from an earlier point. Steps already done are not run again — their results come from the checkpoint. Changes to the graph take effect straight away."
          >
            Restart
          </span>
          {checkpoints.map((checkpoint) => (
            <Button
              key={checkpoint.checkpointId}
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={pending}
              onClick={() => onRestart(checkpoint.checkpointId)}
              aria-label={`Restart before ${checkpoint.next.map(label).join(", ")}`}
            >
              <Icon name="RotateCcw" className="size-3" />
              before {checkpoint.next.map(label).join(", ")}
              <span className="text-muted-foreground">· {checkpoint.doneCount}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
