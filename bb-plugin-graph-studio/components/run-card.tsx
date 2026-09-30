// A run, inline in the conversation that started it.
//
// The banner above the composer says "something is running here" and stays
// while it does. This card is the other half: the record in the message
// history — the graph with its live status, the question it is waiting on and
// a box to answer it — and after the run it stays as the final picture.
//
// Rendered from `::graph-run{run="…"}`, which graph_studio_run hands the agent
// to put in its reply.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { RunDto, rpcContract } from "../server";
import { fanOutProgress } from "../lib/graph";
import { activityByNode } from "../lib/activity";
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

export function GraphRunCard({ attributes }: PluginMessageDirectiveProps) {
  const runId = RUN_ID.test(attributes.run ?? "") ? attributes.run! : null;
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [run, setRun] = useState<RunDto | null | undefined>(undefined);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    if (!runId) return;
    void rpc.call("getRun", { id: runId }).then(
      (result) => setRun(result.run),
      () => setRun(null),
    );
  }, [rpc, runId]);
  useEffect(refetch, [refetch]);
  useRealtime("graph-studio", refetch);

  const statuses = useMemo(() => {
    if (!run) return {};
    const base = statusesFromRun(run);
    for (const [nodeId, progress] of Object.entries(fanOutProgress(run.graph, run.state))) {
      if (base[nodeId] === "failed") continue;
      base[nodeId] = progress.done < progress.total ? "running" : "done";
    }
    return base;
  }, [run]);
  const branches = useMemo(() => (run ? fanOutProgress(run.graph, run.state) : {}), [run]);
  const travelled = useMemo(() => travelledEdges(run ?? null), [run]);
  const activity = useMemo(() => (run ? activityByNode(run.nodeRuns) : {}), [run]);
  // The clock ticks while something is still in flight — including the
  // unwind after a stop, which is work ending, not ended.
  const now = useNow(run?.status === "running" || run?.status === "stopping");

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
  const open = () => {
    const accepted = navigate.openThreadPanel({
      actionId: "studio",
      title: "Graph Studio",
      params: { runId: run.id },
    });
    if (!accepted) navigate.toPluginPanel("studio");
  };

  return (
    <div
      className="my-2 space-y-2 rounded-lg border border-border bg-card p-2"
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
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={open}>
          Open in Graph Studio
        </Button>
      </div>
      <GraphCanvas
        graph={run.graph}
        statuses={statuses}
        branches={branches}
        activeEdgeKeys={travelled}
        activity={activity}
        now={now}
        dimUnreached={run.nodeRuns.length > 0}
        visits={run.state.visits ?? {}}
        onSelect={() => open()}
        className="max-h-[320px]"
      />
      {run.pendingQuestion ? (
        <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/[0.04] px-2 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Waiting for you · {run.pendingQuestion.label}
          </p>
          <Markdown className="max-h-48 overflow-auto text-sm" content={run.pendingQuestion.question} />
          <div className="flex gap-2">
            <Input
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
    </div>
  );
}
