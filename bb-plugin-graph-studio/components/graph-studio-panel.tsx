// The Graph Studio panel: library → run → inspect.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RunDto, rpcContract } from "../server";
import { KIND_LABEL, edgeKey, fanOutProgress, type Graph } from "../lib/graph";
import { describeCost, runCommand, runTotal } from "../lib/describe";
import { activityByNode } from "../lib/activity";
import { GraphPicker } from "./graph-picker";
import { GraphCanvas, CanvasLegend, type NodeVisualStatus } from "./graph-canvas";
import { GraphEditor, type AvailableSkill } from "./graph-editor";
import { ExportedFileView, type ExportedFile } from "./exported-file";
import { CopyCommand } from "./copy-command";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const RUN_STATUS: Record<RunDto["status"], string> = {
  running: "running",
  "waiting-human": "waiting for you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/** Latest attempt per node decides the colour on the canvas. */
function statusesFromRun(run: RunDto | null): Record<string, NodeVisualStatus> {
  if (!run) return {};
  const out: Record<string, NodeVisualStatus> = {};
  for (const nodeRun of run.nodeRuns) {
    out[nodeRun.nodeId] =
      nodeRun.status === "running"
        ? "running"
        : nodeRun.status === "failed"
          ? "failed"
          : nodeRun.status === "done"
            ? "done"
            : "idle";
  }
  if (run.pendingQuestion) out[run.pendingQuestion.nodeId] = "waiting";
  return out;
}

/**
 * A clock that ticks while something is running, and stands still otherwise.
 *
 * The elapsed times cannot come from the realtime updates: those arrive when
 * the run changes, and a node that sits in one tool call for four minutes
 * changes nothing — its counter would freeze at the exact moment the reader
 * starts wondering whether anything is still happening.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Edges between consecutive completed nodes — the path the run actually took. */
function travelledEdges(run: RunDto | null): Set<string> {
  if (!run) return new Set();
  const order = [...run.nodeRuns]
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((nodeRun) => nodeRun.nodeId);
  const keys = new Set<string>();
  for (let index = 1; index < order.length; index += 1) {
    keys.add(edgeKey({ from: order[index - 1]!, to: order[index]! }));
  }
  return keys;
}

function useStudio(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [graphs, setGraphs] = useState<Graph[]>([]);
  const [templates, setTemplates] = useState<Graph[]>([]);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [skills, setSkills] = useState<AvailableSkill[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef(0);

  const refetch = useCallback(() => {
    const id = ++requestId.current;
    void Promise.all([
      rpc.call("listGraphs", null),
      rpc.call("listRuns", { threadId }),
      rpc.call("listSkills", { threadId }),
    ]).then(
      ([library, runList, skillList]) => {
        if (id !== requestId.current) return;
        setGraphs(library.graphs);
        setTemplates(library.templates);
        setRuns(runList.runs);
        setSkills(skillList.skills);
        setSkillsError(skillList.error);
      },
      (cause: unknown) => {
        if (id !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc, threadId]);

  useEffect(refetch, [refetch]);
  useRealtime("graph-studio", refetch);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setPending(true);
      setError(null);
      try {
        await work();
        refetch();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [refetch],
  );

  return {
    rpc,
    graphs,
    templates,
    runs,
    skills,
    skillsError,
    error,
    setError,
    pending,
    run,
    refetch,
  };
}


/* ── inspector ───────────────────────────────────────────────────────────── */

function NodeInspector({
  graph,
  run,
  nodeId,
  onClose,
}: {
  graph: Graph;
  run: RunDto | null;
  nodeId: string;
  onClose: () => void;
}) {
  const navigate = useBbNavigate();
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  const attempts = (run?.nodeRuns ?? []).filter(
    (entry) => entry.nodeId === nodeId,
  );
  if (!node) return null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{node.label}</p>
          <p className="text-[11px] text-muted-foreground">
            {node.id} · {KIND_LABEL[node.kind]} ·
            at most {node.maxVisits}× per run
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
          <Icon name="X" className="size-4" />
        </Button>
      </div>
      <div className="space-y-3 px-3 py-3">
        {node.fields.length > 0 ? (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Result fields
            </p>
            <dl className="mt-1 space-y-0.5">
              {node.fields.map((field) => {
                const value = run?.state.fields?.[node.id]?.[field.name];
                return (
                  <div key={field.name} className="flex gap-2 text-xs">
                    <dt className="shrink-0 font-mono text-muted-foreground">
                      {field.name}
                    </dt>
                    <dd className={value === undefined ? "text-muted-foreground" : ""}>
                      {value === undefined ? "—" : String(value)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ) : null}
        {node.prompt ? (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Prompt
            </p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 text-xs">
              {node.prompt}
            </pre>
          </div>
        ) : null}
        {attempts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Not run yet in this run.
          </p>
        ) : (
          attempts.map((attempt) => (
            <div key={attempt.id} className="rounded-md border border-border p-2">
              <p className="flex items-center justify-between text-xs">
                <span className="font-medium">Versuch {attempt.attempt}</span>
                <span className="text-muted-foreground">{attempt.status}</span>
              </p>
              {describeCost(attempt) ? (
                // What this attempt cost in time and tokens. Absent rather
                // than zero when nothing was measured — see `describeCost`.
                <p className="text-[11px] text-muted-foreground">
                  {describeCost(attempt)}
                </p>
              ) : null}
              {attempt.status === "running" && attempt.activity ? (
                // Only while it runs: afterwards this line would name the last
                // tool call of a finished node as if it were still going.
                <p className="text-[11px] text-muted-foreground">
                  Right now: {attempt.activity}
                </p>
              ) : null}
              {attempt.childThreadId ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1.5 h-6 px-2"
                  onClick={() => navigate.toThread(attempt.childThreadId!)}
                >
                  Open child thread
                </Button>
              ) : null}
              {attempt.error ? (
                <p className="mt-1.5 text-xs text-destructive">{attempt.error}</p>
              ) : null}
              {attempt.output ? (
                <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                  {attempt.output}
                </pre>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ── run view ────────────────────────────────────────────────────────────── */

type Checkpoint = { checkpointId: string; next: string[]; doneCount: number };

function RunView({
  run,
  pending,
  checkpoints,
  onAnswer,
  onStop,
  onBack,
  onRerunFrom,
}: {
  run: RunDto;
  pending: boolean;
  checkpoints: Checkpoint[];
  onAnswer: (answer: string) => void;
  onStop: () => void;
  onBack: () => void;
  onRerunFrom: (checkpointId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  /**
   * Focus mode: the canvas takes the column, everything explanatory steps
   * aside. While a flow runs, the graph *is* the interface — it says where the
   * work stands — and the prose around it is what you read once, at the start.
   */
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);
  const label = (id: string) =>
    run.graph.nodes.find((node) => node.id === id)?.label ?? id;
  const branches = useMemo(() => fanOutProgress(run.graph, run.state), [run]);
  const statuses = useMemo(() => {
    const base = statusesFromRun(run);
    // A fanned-out node has one node_run row per branch, and the last row read
    // wins — so a node with three of seven branches finished can render as
    // "done". The branch count knows better.
    for (const [nodeId, progress] of Object.entries(branches)) {
      if (base[nodeId] === "failed") continue;
      base[nodeId] = progress.done < progress.total ? "running" : "done";
    }
    return base;
  }, [run, branches]);
  const travelled = useMemo(() => travelledEdges(run), [run]);
  const activity = useMemo(() => activityByNode(run.nodeRuns), [run]);
  const now = useNow(run.status === "running");
  const doneCount = run.nodeRuns.filter((node) => node.status === "done").length;
  const total = runTotal(run.nodeRuns);

  return (
    <div
      className={cn(
        focus
          ? // Fill the column and let the canvas have whatever is left after
            // the strip and a pending question. A fixed canvas height would
            // guess wrong the moment the run asks something.
            "flex h-[calc(100dvh-5rem)] flex-col gap-2"
          : "space-y-3",
      )}
    >
      {focus ? (
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <span className="truncate font-medium">{run.graph.name}</span>
          <span
            className={cn(
              "shrink-0 text-muted-foreground",
              run.status === "failed" && "text-destructive",
              run.status === "waiting-human" && "text-primary",
            )}
          >
            {RUN_STATUS[run.status]} · {doneCount} done
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="-mr-2 ml-auto h-6 shrink-0 px-2"
            onClick={() => setFocus(false)}
          >
            <Icon name="X" className="size-4" />
            Leave full screen
          </Button>
        </div>
      ) : (
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Button size="sm" variant="ghost" className="-ml-2 h-6 px-2" onClick={onBack}>
            <Icon name="ChevronLeft" className="size-4" />
            Overview
          </Button>
          <p className="mt-1 truncate text-sm font-medium">{run.graph.name}</p>
          <p className="truncate text-xs text-muted-foreground">„{run.input}"</p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={cn(
              "text-xs font-medium",
              run.status === "failed" && "text-destructive",
              run.status === "waiting-human" && "text-primary",
            )}
          >
            {RUN_STATUS[run.status]}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {doneCount} nodes done · {run.state.steps} steps
          </p>
          {total ? (
            // The run total, so choosing a model per node is a decision with a
            // number behind it rather than a feeling.
            <p className="text-[11px] text-muted-foreground">{total}</p>
          ) : null}
        </div>
      </div>
      )}

      {/*
        Never hidden by focus mode. A run that waits for an answer and says so
        nowhere is a run that quietly stops — the failure this project keeps
        rediscovering. The graph alone cannot tell you: a waiting node looks
        much like a working one.
      */}
      {run.pendingQuestion ? (
        <div className="shrink-0 rounded-lg border border-primary/40 bg-primary/[0.04] px-3 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            The run is waiting for you
          </p>
          <p className="mt-1 text-sm">{run.pendingQuestion.question}</p>
          <div className="mt-2 flex gap-2">
            <Input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Answer"
              aria-label="Answer to the approval"
              disabled={pending}
            />
            <Button
              size="sm"
              disabled={pending || answer.trim() === ""}
              onClick={() => {
                onAnswer(answer.trim());
                setAnswer("");
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {run.error ? (
        <p className="shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {run.error}
        </p>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-1">
        <CanvasLegend />
        {!focus ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => setFocus(true)}
          >
            Full screen
          </Button>
        ) : null}
      </div>

      <div className={cn("relative", focus && "min-h-0 flex-1")}>
        <GraphCanvas
          graph={run.graph}
          statuses={statuses}
          branches={branches}
          selectedId={selected}
          onSelect={setSelected}
          activeEdgeKeys={travelled}
          activity={activity}
          now={now}
          className={focus ? "h-full max-h-none" : "max-h-[55vh]"}
        />
        {focus && selected ? (
          // Over the canvas rather than under it: in focus mode there is no
          // "under", and pushing the graph up to make room would undo the
          // point of the mode.
          <div className="absolute inset-x-0 bottom-0 max-h-[60%] overflow-auto rounded-t-lg border border-border bg-card p-2 shadow-lg">
            <NodeInspector
              graph={run.graph}
              run={run}
              nodeId={selected}
              onClose={() => setSelected(null)}
            />
          </div>
        ) : null}
      </div>

      {!focus ? (
        selected ? (
          <NodeInspector
            graph={run.graph}
            run={run}
            nodeId={selected}
            onClose={() => setSelected(null)}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Click a node to see its prompt, result and child thread.
          </p>
        )
      ) : null}

      {!focus && run.status !== "running" && checkpoints.length > 0 ? (
        <details className="rounded-lg border border-border bg-card">
          <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium">
            Replay from a step
          </summary>
          <div className="space-y-2 border-t border-border px-3 py-3">
            <p className="text-[11px] text-muted-foreground">
              Continues the run from an earlier point. Steps already done are
              not run again — their results come from the checkpoint. Changes to
              the graph take effect straight away.
            </p>
            {checkpoints.map((checkpoint) => (
              <div
                key={checkpoint.checkpointId}
                className="flex items-center justify-between gap-3"
              >
                <span className="min-w-0 text-xs">
                  before{" "}
                  <span className="font-medium">
                    {checkpoint.next.map(label).join(", ")}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {checkpoint.doneCount}{" "}
                    {checkpoint.doneCount === 1 ? "result" : "results"} available
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={pending}
                  onClick={() => onRerunFrom(checkpoint.checkpointId)}
                >
                  <Icon name="RotateCcw" className="size-4" />
                  Restart here
                </Button>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {!focus && (run.status === "running" || run.status === "waiting-human") ? (
        <Button size="sm" variant="destructive" disabled={pending} onClick={onStop}>
          Stop the run
        </Button>
      ) : null}
    </div>
  );
}

/* ── library ─────────────────────────────────────────────────────────────── */

function Library({
  graphs,
  runs,
  pending,
  threadId,
  graphId,
  task,
  onGraphIdChange,
  onTaskChange,
  onStart,
  onOpenRun,
  onEdit,
  onNew,
  onExport,
  onImport,
  exported,
  exporting,
  onDismissExport,
}: {
  graphs: Graph[];
  runs: RunDto[];
  pending: boolean;
  threadId: string | null;
  graphId: string;
  task: string;
  onGraphIdChange: (graphId: string) => void;
  onTaskChange: (task: string) => void;
  onStart: (graphId: string, input: string) => void;
  onOpenRun: (runId: string) => void;
  onEdit: (graphId: string) => void;
  onNew: () => void;
  onExport: (id: string) => void;
  onImport: (json: string) => void;
  exported: ExportedFile | null;
  exporting: boolean;
  onDismissExport: () => void;
}) {
  const [importText, setImportText] = useState("");
  const active = graphId || graphs[0]?.id || "";
  const preview = graphs.find((graph) => graph.id === active) ?? null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card px-3 py-3">
        <p className="text-sm font-medium">Start a run</p>
        <div className="mt-2 space-y-2">
          {/* No caption above: the card says "Start a run" and the options
              are graph names. The label was a line of height for nothing. */}
          <GraphPicker
            graphs={graphs}
            value={active}
            onChange={onGraphIdChange}
            disabled={pending}
          />
          <Input
            value={task}
            onChange={(event) => onTaskChange(event.target.value)}
            // The RPC rejects anything longer (server.ts, `startRun`), and a
            // rejection here would come after the typing, as a schema error
            // nobody can act on. The field stops at the same number instead.
            maxLength={8000}
            // The graph's own example, so the empty field already answers
            // "what does this one expect from me".
            placeholder={preview?.example || "What should be worked on?"}
            aria-label="Task"
            disabled={pending}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={pending || !active || task.trim() === "" || !threadId}
              onClick={() => onStart(active, task.trim())}
            >
              Start
            </Button>
            <Button size="sm" variant="outline" onClick={() => onEdit(active)}>
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={onNew}>
              <Icon name="Plus" className="size-4" />
              New
            </Button>
          </div>
          {!threadId ? (
            <p className="text-[11px] text-muted-foreground">
              A run needs a thread — the workers inherit its working
              environment.
            </p>
          ) : null}
          {preview ? (
            // The same run, as a line for the terminal. It follows the field
            // above as you type and falls back to the graph's own example, so
            // it is never a syntax lesson with "<task>" in the middle.
            <div className="space-y-1 border-t border-border pt-2">
              <p className="text-[11px] text-muted-foreground">
                Or on the command line:
              </p>
              <CopyCommand command={runCommand(preview, task)} />
            </div>
          ) : null}
        </div>
      </div>

      {preview ? (
        // Caption, description and legend used to be three stacked blocks
        // around the picture — in a side panel that is most of a screenful
        // before the graph even starts. Caption and legend now share a row,
        // and the description sits directly under it rather than pushing the
        // canvas down with its own gap.
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Preview
            </p>
            <CanvasLegend />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {preview.description}
          </p>
          <GraphCanvas graph={preview} className="max-h-[55vh]" />
        </div>
      ) : null}

      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium">
          File: export / import
        </summary>
        <div className="space-y-3 border-t border-border px-3 py-3">
          <p className="text-[11px] text-muted-foreground">
            Graphs live centrally in the plugin database and are therefore
            available in every project. As a JSON file they can additionally be
            put into the repo, versioned and shared.
          </p>
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">
              Write out the graph selected above:
            </p>
            {active ? (
              <Button
                size="sm"
                variant="outline"
                disabled={exporting}
                onClick={() => onExport(active)}
              >
                <Icon name="Download" className="size-4" />
                {exporting
                  ? "Exporting …"
                  : preview
                    ? `"${preview.name}" as JSON`
                    : "As JSON"}
              </Button>
            ) : (
              // An inert greyed-out button eats the click and says nothing;
              // before the library has arrived there is nothing to export.
              <p className="text-[11px] text-muted-foreground">
                Loading graphs …
              </p>
            )}
            <ExportedFileView exported={exported} onDismiss={onDismissExport} />
          </div>
          <div className="space-y-1">
            <label
              className="block text-[11px] text-muted-foreground"
              htmlFor="gs-library-import"
            >
              Paste JSON and import it as a new graph
            </label>
            <textarea
              id="gs-library-import"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={4}
              placeholder={'{ "version": 1, "graph": { … } }'}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[11px]"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || importText.trim() === ""}
              onClick={() => onImport(importText)}
            >
              Import
            </Button>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">
              On the command line:
            </p>
            <CopyCommand
              command={`bb graph-studio export ${active || "<graph-id>"} > file.json`}
            />
            <CopyCommand command="bb graph-studio import file.json" />
          </div>
        </div>
      </details>

      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Runs
        </p>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-state-hover"
                  onClick={() => onOpenRun(run.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{run.graph.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      „{run.input}"
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px]",
                      run.status === "failed" && "text-destructive",
                      run.status === "waiting-human" && "text-primary",
                    )}
                  >
                    {RUN_STATUS[run.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── panel ───────────────────────────────────────────────────────────────── */

type View =
  | { kind: "library" }
  | { kind: "run"; runId: string }
  | { kind: "edit"; graphId: string | null };

/**
 * Everything the panel shows that belongs to *one* conversation. Which run is
 * open and which graph is armed in "Start a run" are answers to "what am I
 * doing in this thread", not to "what did I last click anywhere in BB".
 */
type PanelState = {
  view: View;
  /** The graph the "Start a run" card is aimed at; "" means the first one. */
  graphId: string;
  task: string;
};

const BLANK_PANEL: PanelState = {
  view: { kind: "library" },
  graphId: "",
  task: "",
};

/**
 * The host keeps one panel component alive and swaps `threadId` underneath it
 * when you change conversation. Plain `useState` therefore travelled: open the
 * studio on a run in thread A, switch to thread B, and B showed A's run — or,
 * because `listRuns` is scoped to the thread, an eternal "Loading the run …"
 * for a run B does not own.
 *
 * So the state is a map keyed by thread. Switching away and back restores what
 * was open there instead of resetting it.
 */
function usePanelState(threadId: string | null) {
  const key = threadId ?? "";
  const [byThread, setByThread] = useState<Record<string, PanelState>>({});
  const patch = useCallback(
    (change: Partial<PanelState>) =>
      setByThread((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? BLANK_PANEL), ...change },
      })),
    [key],
  );
  const setView = useCallback((view: View) => patch({ view }), [patch]);
  return { state: byThread[key] ?? BLANK_PANEL, patch, setView };
}

export function GraphStudioPanel({
  threadId: prop,
  initialRunId = null,
}: {
  threadId?: string | null;
  /** Opened from the run banner: land on that run instead of the library. */
  initialRunId?: string | null;
}) {
  const ctx = useBbContext();
  const threadId = prop ?? ctx.threadId;
  const {
    rpc,
    graphs,
    templates,
    runs,
    skills,
    skillsError,
    error,
    setError,
    pending,
    run,
    refetch,
  } = useStudio(threadId);
  const { state, patch, setView } = usePanelState(threadId);
  const view = state.view;

  // A second click on the banner while the panel is already open reuses this
  // component, so the run only changes through the prop — but the prop is the
  // *tab's* params and survives a thread switch, so it may still name the run
  // of the thread we came from. `runs` is scoped to the current thread, which
  // makes it the honest test of ownership. The token stops a refetch from
  // dragging the user back to the run after they have left it.
  const appliedRun = useRef<string | null>(null);
  useEffect(() => {
    if (!initialRunId) return;
    if (!runs.some((entry) => entry.id === initialRunId)) return;
    const token = `${threadId ?? ""}|${initialRunId}`;
    if (appliedRun.current === token) return;
    appliedRun.current = token;
    setView({ kind: "run", runId: initialRunId });
  }, [initialRunId, runs, threadId, setView]);
  const [exported, setExported] = useState<ExportedFile | null>(null);
  const [exporting, setExporting] = useState(false);

  // Export is read-only: it must not ride on the panel-wide `pending` flag.
  // Doing so disabled the button whenever any other action was in flight, and
  // a click on a disabled button is dropped without a trace.
  const exportGraph = useCallback(
    (id: string) => {
      void (async () => {
        setExporting(true);
        setError(null);
        try {
          setExported(await rpc.call("exportGraph", { id }));
        } catch (cause) {
          setExported(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setExporting(false);
        }
      })();
    },
    [rpc, setError],
  );

  // The output is anchored to the button that produced it, so it must not
  // travel to the next screen.
  useEffect(() => setExported(null), [view.kind, threadId]);

  const importGraph = useCallback(
    (json: string) =>
      void run(async () => {
        const result = await rpc.call("importGraph", { json, overwrite: false });
        refetch();
        setView({ kind: "edit", graphId: result.graph.id });
      }),
    [rpc, run, refetch],
  );

  const openRun = runs.find(
    (entry) => view.kind === "run" && entry.id === view.runId,
  );

  // Restart points are only meaningful for a run that is not moving.
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const openRunId = openRun?.id ?? null;
  const openRunStatus = openRun?.status ?? null;
  useEffect(() => {
    if (!openRunId || openRunStatus === "running") {
      setCheckpoints([]);
      return;
    }
    let cancelled = false;
    void rpc.call("listCheckpoints", { runId: openRunId }).then(
      (result) => {
        if (!cancelled) setCheckpoints(result.checkpoints);
      },
      () => {
        if (!cancelled) setCheckpoints([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, openRunId, openRunStatus]);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        {view.kind === "library" ? (
          <Library
            graphs={graphs}
            runs={runs}
            pending={pending}
            threadId={threadId}
            graphId={state.graphId}
            task={state.task}
            onGraphIdChange={(graphId) => patch({ graphId })}
            onTaskChange={(task) => patch({ task })}
            onStart={(graphId, input) =>
              void run(async () => {
                const result = await rpc.call("startRun", {
                  graphId,
                  input,
                  threadId,
                  projectId: ctx.projectId ?? null,
                });
                setView({ kind: "run", runId: result.run.id });
              })
            }
            onOpenRun={(runId) => setView({ kind: "run", runId })}
            onEdit={(graphId) => setView({ kind: "edit", graphId })}
            onNew={() => setView({ kind: "edit", graphId: null })}
            onExport={exportGraph}
            onImport={importGraph}
            exported={exported}
            exporting={exporting}
            onDismissExport={() => setExported(null)}
          />
        ) : null}

        {view.kind === "run" ? (
          openRun ? (
            <RunView
              run={openRun}
              pending={pending}
              checkpoints={checkpoints}
              onBack={() => setView({ kind: "library" })}
              onRerunFrom={(checkpointId) =>
                void run(() =>
                  rpc.call("rerunFrom", { runId: openRun.id, checkpointId }),
                )
              }
              onAnswer={(answer) =>
                void run(() =>
                  rpc.call("answerHuman", { runId: openRun.id, answer }),
                )
              }
              onStop={() =>
                void run(() => rpc.call("stopRun", { runId: openRun.id }))
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading the run …</p>
          )
        ) : null}

        {view.kind === "edit" ? (
          <GraphEditor
            // The draft lives in the editor's own state, so it must remount
            // when the target changes — otherwise cloning a template leaves
            // the blank draft on screen and the clone looks like a no-op.
            key={`${view.graphId ?? "new"}:${
              graphs.find((entry) => entry.id === view.graphId)?.updatedAt ?? 0
            }`}
            graphs={graphs}
            templates={templates}
            availableSkills={skills}
            skillsError={skillsError}
            onExport={exportGraph}
            onImport={importGraph}
            exported={exported}
            exporting={exporting}
            onDismissExport={() => setExported(null)}
            graphId={view.graphId}
            pending={pending}
            onCancel={() => setView({ kind: "library" })}
            onSave={(graph) =>
              void run(async () => {
                await rpc.call("saveGraph", { graph });
                refetch();
                setView({ kind: "library" });
              })
            }
            onClone={(templateId, id, name) =>
              void run(async () => {
                await rpc.call("cloneTemplate", { templateId, id, name });
                setView({ kind: "edit", graphId: id });
              })
            }
            onDelete={(id) =>
              void run(async () => {
                await rpc.call("deleteGraph", { id });
                setView({ kind: "library" });
              })
            }
          />
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function GraphStudioHeaderAction({
  isCompactViewport,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();
  return (
    <Button
      size={isCompactViewport ? "icon" : "sm"}
      variant="ghost"
      aria-label="Open Graph Studio"
      onClick={() =>
        navigate.openThreadPanel({ actionId: "studio", title: "Graph Studio" })
      }
    >
      <Icon name="Workflow" className="size-4" />
      {isCompactViewport ? null : "Graph"}
    </Button>
  );
}
