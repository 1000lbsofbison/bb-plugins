// The way back from a chat to the graph it started.
//
// Working side by side, the panel alone is not enough: it opens in *a* window
// and gives no clue which conversation it belongs to. The banner sits above
// the composer of the thread that owns the run, so the route is always
// "the run I can see" → "the graph behind it", never a guess.
import { useCallback, useEffect, useState } from "react";
import {
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RunDto, rpcContract } from "../server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Belt and braces against a long question: CSS truncation handles the visual
 * width, but a single unbroken line still feeds the layout an enormous
 * intrinsic width to negotiate with. Cutting it here keeps that number small.
 */
function firstLine(text: string, limit = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** What the banner says about a run, in one line. */
function summarise(run: RunDto): { line: string; waiting: boolean } {
  if (run.pendingQuestion) {
    return { line: firstLine(run.pendingQuestion.question), waiting: true };
  }
  const running = run.nodeRuns.find((node) => node.status === "running");
  const label = running
    ? (run.graph.nodes.find((node) => node.id === running.nodeId)?.label ??
      running.nodeId)
    : null;
  return { line: label ? `${label} running` : "running", waiting: false };
}

export function GraphStudioRunBanner() {
  const { threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [runs, setRuns] = useState<RunDto[]>([]);

  const refetch = useCallback(() => {
    if (!threadId) {
      setRuns([]);
      return;
    }
    void rpc.call("listRuns", { threadId }).then(
      (result) => setRuns(result.runs),
      // A banner is decoration: a failed poll must not put an error in the
      // user's way while they are typing.
      () => setRuns([]),
    );
  }, [rpc, threadId]);

  useEffect(refetch, [refetch]);
  useRealtime("graph-studio", refetch);

  const active = runs.filter(
    (run) => run.status === "running" || run.status === "waiting-human",
  );
  if (active.length === 0) return null;

  const run = active[0]!;
  const { line, waiting } = summarise(run);

  const open = () => {
    const accepted = navigate.openThreadPanel({
      actionId: "studio",
      title: "Graph Studio",
      params: { runId: run.id },
    });
    // Surfaces without a thread side panel still get somewhere useful.
    if (!accepted) navigate.toPluginPanel("studio");
  };

  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        // `min-w-0` and `max-w-full` are the load-bearing part: without them
        // the button claims the intrinsic width of an unwrapped question and
        // pushes the composer's submit button out of view until something
        // else forces a re-layout. `truncate` on the label only takes effect
        // once every ancestor is allowed to shrink.
        "flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border px-2.5 py-1.5 text-left text-xs",
        waiting
          ? "border-blue-500/40 bg-blue-500/10"
          : "border-border bg-muted/50",
      )}
      aria-label={`Graph Studio: open ${run.graph.name}`}
    >
      <Icon
        name="Workflow"
        className={cn("size-3.5 shrink-0", waiting && "text-blue-600")}
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{run.graph.name}</span>
        <span className="text-muted-foreground">
          {" · "}
          {waiting ? "waiting for you: " : ""}
          {line}
        </span>
      </span>
      {active.length > 1 ? (
        <span className="shrink-0 text-muted-foreground">
          +{active.length - 1}
        </span>
      ) : null}
      <Icon name="ChevronRight" className="size-3.5 shrink-0 opacity-60" />
    </button>
  );
}
