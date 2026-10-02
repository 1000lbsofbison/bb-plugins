// The way back from a chat to the graph it started.
//
// Working side by side, the panel alone is not enough: it opens in *a* window
// and gives no clue which conversation it belongs to. The banner sits above
// the composer of the thread that owns the run, so the route is always
// "the run I can see" → "the graph behind it", never a guess. Expanded, it is
// also the one live picture of the run: the graph, the question it waits on
// and the answer box, in place instead of repeated through the history.
import { useCallback, useEffect, useState } from "react";
import {
  useBbContext,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RunDto, rpcContract } from "../server";
import { Icon } from "@/components/ui/icon";
import { GraphStudioFlow } from "./graph-studio-icon";
import { RunView, isLive, onRunFocusRequest, useOpenRun } from "./run-card";
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
  if (run.status === "stopping") {
    return { line: "stopping", waiting: false };
  }
  const running = run.nodeRuns.find((node) => node.status === "running");
  const label = running
    ? (run.graph.nodes.find((node) => node.id === running.nodeId)?.label ??
      running.nodeId)
    : null;
  return { line: label ? `${label} running` : "running", waiting: false };
}

/** Collapsing is a preference, not a per-run choice: it holds across runs. */
const COLLAPSED_KEY = "graph-studio:run-banner-collapsed";

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage can be unavailable; the toggle still works for this session.
  }
}

export function GraphStudioRunBanner() {
  const { threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const openRun = useOpenRun();
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // The run whose graph is shown; null picks one (see `expanded` below).
  const [chosen, setChosen] = useState<string | null>(null);
  // Bumped by a jump from a card: RunView focuses its answer box on change.
  const [focusToken, setFocusToken] = useState(0);

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

  const active = runs.filter(isLive);
  const ids = active.map((run) => run.id);

  // A card's "Answer" jumps here: open that run's graph, focus its answer.
  useEffect(
    () =>
      onRunFocusRequest((runId) => {
        if (!ids.includes(runId)) return false;
        setChosen(runId);
        setCollapsed(false);
        writeCollapsed(false);
        setFocusToken((token) => token + 1);
        return true;
      }),
    [ids.join(",")],
  );

  if (active.length === 0) return null;

  // At most one graph is open, however many runs are live: a stack of forms
  // would push the conversation out of view. Without a choice, the run that
  // waits for an answer wins over one that merely runs.
  const expanded = collapsed
    ? null
    : (active.find((run) => run.id === chosen) ??
      active.find((run) => run.status === "waiting-human") ??
      active[0]!);
  const anyWaiting = active.some((run) => run.pendingQuestion);

  const toggle = (run: RunDto) => {
    const closing = expanded?.id === run.id;
    setChosen(run.id);
    setCollapsed(closing);
    writeCollapsed(closing);
  };

  return (
    <div
      className={cn(
        // `min-w-0` and `max-w-full` are the load-bearing part: without them
        // the banner claims the intrinsic width of an unwrapped question and
        // pushes the composer's submit button out of view until something
        // else forces a re-layout. `truncate` on the label only takes effect
        // once every ancestor is allowed to shrink.
        "relative isolate w-full min-w-0 max-w-full overflow-hidden rounded-md border text-xs [clip-path:inset(0_round_0.375rem)]",
        anyWaiting
          ? "border-blue-500/40 bg-blue-500/10"
          : "border-border bg-muted/50",
      )}
    >
      {active.map((run, index) => {
        const { line, waiting } = summarise(run);
        const open = expanded?.id === run.id;
        return (
          <div
            key={run.id}
            className={cn(index > 0 && "border-t border-border/60")}
          >
            <div className="flex min-w-0 items-center">
              <button
                type="button"
                onClick={() => openRun(run.id)}
                className="flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden px-2.5 py-1.5 text-left"
                aria-label={`Graph Studio: open ${run.graph.name}`}
              >
                <GraphStudioFlow
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
              </button>
              <button
                type="button"
                onClick={() => toggle(run)}
                className="shrink-0 px-2 py-1.5 opacity-60 hover:opacity-100"
                aria-label={open ? "Hide the graph" : "Show the graph"}
                aria-expanded={open}
              >
                <Icon
                  name={open ? "ChevronUp" : "ChevronDown"}
                  className="size-3.5"
                />
              </button>
            </div>
            {open ? (
              <div className="space-y-2 border-t border-border/60 bg-card p-2">
                <RunView
                  run={run}
                  refetch={refetch}
                  canvasClassName="max-h-[240px]"
                  focusToken={focusToken}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
