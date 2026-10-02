// A run, inline in the conversation that started it.
//
// The banner above the composer holds the live picture while a run is in
// flight: the graph, the question it waits on and the answer box. The card in
// the message history is the record: a single line while the run lives — the
// banner already shows it, and agents that are woken on every status change
// tend to repeat the directive — and the final picture once it has ended,
// drawn once per run, however often the directive appears.
//
// Rendered from `::graph-run{run="…"}`, which graph_studio_run hands the agent
// to put in its reply.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { RunDto, rpcContract } from "../server";
import { fanOutProgress } from "../lib/graph";
import { activityByNode, durationByNode } from "../lib/activity";
import { GraphCanvas } from "./graph-canvas";
import {
  RUN_STATUS,
  statusesFromRun,
  travelledEdges,
  useNow,
} from "./graph-studio-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Run ids are generated; anything else in the attribute is not ours. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isLive(run: RunDto): boolean {
  return (
    run.status === "running" ||
    run.status === "stopping" ||
    run.status === "waiting-human"
  );
}

/** Opens the studio on a run, from wherever a run is shown. */
export function useOpenRun(): (runId: string) => void {
  const navigate = useBbNavigate();
  return useCallback(
    (runId: string) => {
      const accepted = navigate.openThreadPanel({
        actionId: "studio",
        title: "Graph Studio",
        params: { runId },
      });
      // Surfaces without a thread side panel still get somewhere useful.
      if (!accepted) navigate.toPluginPanel("studio");
    },
    [navigate],
  );
}

/**
 * The jump from a card to the banner. The two are separate slots with no
 * shared React tree, so the request goes through a small module-level
 * channel; the banner answers whether it holds that run.
 */
type FocusListener = (runId: string) => boolean;
const focusListeners = new Set<FocusListener>();

export function onRunFocusRequest(listener: FocusListener): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

/** True when a banner took the request; false when none shows this run. */
export function requestRunFocus(runId: string): boolean {
  let handled = false;
  for (const listener of focusListeners) handled = listener(runId) || handled;
  return handled;
}

/**
 * Which card of a run draws the full picture: the first one mounted. The
 * others — a directive repeated in later replies — stay a single line, so the
 * history does not fill up with copies of the same graph.
 */
const primaryCard = new Map<string, symbol>();

function usePrimaryCard(runId: string | null): boolean {
  const [token] = useState(() => Symbol("graph-run-card"));
  const [primary, setPrimary] = useState(false);
  useEffect(() => {
    if (!runId) return;
    if (!primaryCard.has(runId)) primaryCard.set(runId, token);
    setPrimary(primaryCard.get(runId) === token);
    return () => {
      if (primaryCard.get(runId) === token) primaryCard.delete(runId);
    };
  }, [runId, token]);
  return primary;
}

/** The graph with its live status, the pending question and the answer box. */
export function RunView({
  run,
  refetch,
  canvasClassName,
  focusToken = 0,
}: {
  run: RunDto;
  refetch: () => void;
  canvasClassName?: string;
  /** Focuses the answer box whenever it changes (from 0). */
  focusToken?: number;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const openRun = useOpenRun();
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusToken > 0) answerRef.current?.focus();
  }, [focusToken, run.pendingQuestion?.nodeId]);

  const statuses = useMemo(() => {
    const base = statusesFromRun(run);
    for (const [nodeId, progress] of Object.entries(fanOutProgress(run.graph, run.state))) {
      if (base[nodeId] === "failed") continue;
      base[nodeId] = progress.done < progress.total ? "running" : "done";
    }
    return base;
  }, [run]);
  const branches = useMemo(() => fanOutProgress(run.graph, run.state), [run]);
  const travelled = useMemo(() => travelledEdges(run), [run]);
  const activity = useMemo(() => activityByNode(run.nodeRuns), [run]);
  const durations = useMemo(() => durationByNode(run.nodeRuns), [run]);
  // The clock ticks while something is still in flight — including the
  // unwind after a stop, which is work ending, not ended.
  const now = useNow(run.status === "running" || run.status === "stopping");

  return (
    <>
      <GraphCanvas
        graph={run.graph}
        statuses={statuses}
        branches={branches}
        activeEdgeKeys={travelled}
        activity={activity}
        durations={durations}
        now={now}
        dimUnreached={run.nodeRuns.length > 0}
        visits={run.state.visits ?? {}}
        onSelect={() => openRun(run.id)}
        className={canvasClassName}
      />
      {run.pendingQuestion ? (
        <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/[0.04] px-2 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Waiting for you · {run.pendingQuestion.label}
          </p>
          <Markdown className="max-h-48 overflow-auto text-sm" content={run.pendingQuestion.question} />
          <div className="flex gap-2">
            <Input
              ref={answerRef}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Answer"
              aria-label="Answer to the approval"
              disabled={sending}
            />
            <Button
              size="sm"
              disabled={sending || answer.trim() === ""}
              onClick={() => {
                const nodeId = run.pendingQuestion!.nodeId;
                setSending(true);
                setError(null);
                void rpc
                  .call("answerHuman", { runId: run.id, answer: answer.trim(), nodeId })
                  .then(
                    () => {
                      setAnswer("");
                      refetch();
                    },
                    (cause: unknown) =>
                      setError(cause instanceof Error ? cause.message : String(cause)),
                  )
                  .finally(() => setSending(false));
              }}
            >
              Continue
            </Button>
          </div>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
      {run.error ? (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{run.error}</p>
      ) : null}
    </>
  );
}

export function GraphRunCard({ attributes }: PluginMessageDirectiveProps) {
  const runId = RUN_ID.test(attributes.run ?? "") ? attributes.run! : null;
  const rpc = useRpc<typeof rpcContract>();
  const openRun = useOpenRun();
  const primary = usePrimaryCard(runId);
  const [run, setRun] = useState<RunDto | null | undefined>(undefined);

  const refetch = useCallback(() => {
    if (!runId) return;
    void rpc.call("getRun", { id: runId }).then(
      (result) => setRun(result.run),
      () => setRun(null),
    );
  }, [rpc, runId]);
  useEffect(refetch, [refetch]);
  useRealtime("graph-studio", refetch);

  if (!runId) {
    return (
      <p className="text-xs text-muted-foreground">
        Graph Studio: this card names no run.
      </p>
    );
  }
  if (run === undefined) {
    return <p className="text-xs text-muted-foreground">Loading the run …</p>;
  }
  if (run === null) {
    return (
      <p className="text-xs text-muted-foreground">
        Graph Studio: run {runId} is not available here.
      </p>
    );
  }

  const done = run.nodeRuns.filter((entry) => entry.status === "done").length;
  const full = primary && !isLive(run);

  return (
    <div
      className={cn(
        "my-2 rounded-lg border border-border bg-card",
        full ? "space-y-2 p-2" : "px-1 py-1",
      )}
      aria-label={`Graph Studio run ${run.graph.name}`}
    >
      <div className="flex items-center gap-2 px-1 text-xs">
        <span className="truncate font-medium">{run.graph.name}</span>
        <span
          className={cn(
            "shrink-0 text-muted-foreground",
            run.status === "failed" && "text-destructive",
            run.status === "waiting-human" && "text-primary",
          )}
        >
          {RUN_STATUS[run.status]} · {done} done
          {isLive(run) ? " · live above the composer" : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-[11px]"
          onClick={() => openRun(run.id)}
        >
          Open in Graph Studio
        </Button>
      </div>
      {primary && run.pendingQuestion ? (
        <div className="mt-1 flex min-w-0 items-center gap-2 rounded-md border border-primary/40 bg-primary/[0.04] px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-primary">Waiting for you</span>
            <span className="text-muted-foreground"> · {run.pendingQuestion.label}</span>
          </span>
          <Button
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => {
              // No banner shows this run here (another thread, another
              // surface): the studio is the place to answer then.
              if (!requestRunFocus(run.id)) openRun(run.id);
            }}
          >
            Answer
          </Button>
        </div>
      ) : null}
      {full ? <RunView run={run} refetch={refetch} canvasClassName="max-h-[320px]" /> : null}
    </div>
  );
}
