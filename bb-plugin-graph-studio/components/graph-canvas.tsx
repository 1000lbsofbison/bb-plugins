// The graph canvas.
//
// Plain SVG over the shared layout in lib/layout.ts — no chart library, no
// canvas runtime, so it inherits the BB theme's CSS variables and stays crisp
// at any zoom. Nodes carry live run status; back edges are drawn as arcs on
// the right so a cycle reads as a cycle.
import { useMemo } from "react";
import {
  END_NODE,
  KIND_LABEL,
  START_NODE,
  nodeExecution,
  type Graph,
} from "../lib/graph";
import { layoutGraph, type PlacedNode } from "../lib/layout";
import { elapsedLabel } from "../lib/activity";
import { cn } from "@/lib/utils";

/**
 * Model ids are long and front-loaded with the vendor ("claude-opus-5"); the
 * part that distinguishes two nodes sits at the end, so the tail is what a
 * 172px node shows.
 */
function shortModel(model: string): string {
  const tail = model.split("/").pop() ?? model;
  return tail.length > 14 ? `…${tail.slice(-13)}` : tail;
}

export type NodeVisualStatus =
  | "idle"
  | "running"
  | "done"
  | "failed"
  | "waiting";

export type GraphCanvasProps = {
  graph: Graph;
  /** Per-node run status; missing ids render as `idle`. */
  statuses?: Record<string, NodeVisualStatus>;
  /**
   * Branch progress for nodes that run fanned out. A node running n times has
   * no single status, so it says "3 of 7 done" instead of pretending one.
   */
  branches?: Record<string, { done: number; total: number }>;
  /** Which node the inspector is showing. */
  selectedId?: string | null;
  onSelect?: (nodeId: string | null) => void;
  /** Draw the edge into this node highlighted — the path the run just took. */
  activeEdgeKeys?: Set<string>;
  /**
   * Live signs of life for running nodes: since when, and what the worker is
   * doing. A node can sit in `running` for ten minutes, and without these two
   * the canvas says exactly as much in minute ten as in minute one.
   */
  activity?: Record<string, { startedAt: number | null; text: string | null }>;
  /**
   * "Now", for the elapsed times. Passed in rather than read here so the whole
   * canvas ticks on one clock the owner controls — and so a test can state
   * what time it is.
   */
  now?: number;
  /**
   * Extra classes on the scroll container — in practice a height cap. The SVG
   * is as tall as the layout needs, and a layered graph grows downwards: eight
   * layers are already over a thousand pixels. Without a cap the preview
   * pushes everything below it off the screen, which is the opposite of what a
   * preview is for.
   */
  className?: string;
};

const STATUS_FILL: Record<NodeVisualStatus, string> = {
  idle: "var(--card)",
  running: "color-mix(in oklab, var(--primary) 14%, var(--card))",
  done: "color-mix(in oklab, var(--primary) 7%, var(--card))",
  failed: "color-mix(in oklab, var(--destructive) 12%, var(--card))",
  waiting: "color-mix(in oklab, var(--primary) 20%, var(--card))",
};

const STATUS_STROKE: Record<NodeVisualStatus, string> = {
  idle: "var(--border)",
  running: "var(--primary)",
  done: "color-mix(in oklab, var(--primary) 55%, var(--border))",
  failed: "var(--destructive)",
  waiting: "var(--primary)",
};

const STATUS_LABEL: Record<NodeVisualStatus, string> = {
  idle: "open",
  running: "running",
  done: "done",
  failed: "failed",
  waiting: "waiting",
};

function Terminal({ node, label }: { node: PlacedNode; label: string }) {
  return (
    <g>
      <rect
        x={node.x + node.width / 2 - 34}
        y={node.y + node.height / 2 - 13}
        width={68}
        height={26}
        rx={13}
        fill="var(--muted)"
        stroke="var(--border)"
      />
      <text
        x={node.x + node.width / 2}
        y={node.y + node.height / 2 + 4}
        textAnchor="middle"
        className="fill-muted-foreground"
        style={{ fontSize: 11 }}
      >
        {label}
      </text>
    </g>
  );
}

export function GraphCanvas({
  graph,
  statuses = {},
  branches = {},
  selectedId = null,
  onSelect,
  activeEdgeKeys,
  activity = {},
  now,
  className,
}: GraphCanvasProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );

  return (
    <div
      className={cn(
        "overflow-auto rounded-lg border border-border bg-background",
        className,
      )}
    >
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block max-w-none"
        role="img"
        aria-label={`Graph ${graph.name}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`}
      >
        <defs>
          <marker
            id="gs-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
          </marker>
          <marker
            id="gs-arrow-back"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          const active = activeEdgeKeys?.has(edge.key) ?? false;
          return (
            <g key={edge.key}>
              <path
                d={edge.path}
                fill="none"
                stroke={
                  edge.isBack
                    ? "var(--primary)"
                    : active
                      ? "var(--primary)"
                      : "var(--border)"
                }
                strokeWidth={active || edge.isBack ? 2 : 1.5}
                // Three claims, three strokes: solid goes here, dashed goes
                // here if a condition holds, dotted may go here because a
                // worker decides at run time.
                strokeDasharray={
                  edge.candidate ? "2 5" : edge.conditional ? "5 4" : undefined
                }
                opacity={edge.candidate ? 0.7 : undefined}
                markerEnd={`url(#${edge.isBack ? "gs-arrow-back" : "gs-arrow"})`}
              />
              {edge.label ? (
                <text
                  x={edge.labelX}
                  y={edge.labelY}
                  textAnchor={edge.isBack ? "end" : "middle"}
                  className="fill-muted-foreground"
                  style={{ fontSize: 10 }}
                >
                  <tspan
                    dy="-3"
                    style={{
                      paintOrder: "stroke",
                      stroke: "var(--background)",
                      strokeWidth: 4,
                    }}
                  >
                    {edge.label}
                  </tspan>
                </text>
              ) : null}
            </g>
          );
        })}

        {layout.nodes.map((placed) => {
          if (placed.id === START_NODE) {
            return <Terminal key={placed.id} node={placed} label="Start" />;
          }
          if (placed.id === END_NODE) {
            return <Terminal key={placed.id} node={placed} label="End" />;
          }
          const node = byId.get(placed.id);
          if (!node) return null;
          const status = statuses[placed.id] ?? "idle";
          const selected = selectedId === placed.id;
          // A fanned-out node reports its branches instead of one status: "3
          // of 7 done" is the honest answer where "done" would be a lie
          // about the four still running.
          const branch = branches[placed.id];
          const statusText = branch
            ? `${branch.done} of ${branch.total} done`
            : STATUS_LABEL[status];
          // A node on its own model is drawn exactly like one that inherits,
          // and that difference is what explains two agents behaving
          // differently. The short name is enough on the canvas; the full one
          // is in the tooltip and the editor.
          const execution = nodeExecution(node);
          // The label gives up room for the model marker rather than running
          // underneath it.
          const labelRoom = execution ? 14 : 22;
          // Signs of life, shown only while the node runs. Afterwards the
          // duration belongs to the inspector, which has room to be exact,
          // and the last tool call is no longer news.
          const live = status === "running" ? activity[placed.id] : undefined;
          const elapsed =
            live && live.startedAt !== null && now !== undefined
              ? elapsedLabel(live.startedAt, now)
              : null;
          const doing = live?.text ?? null;

          return (
            <g
              key={placed.id}
              className="cursor-pointer"
              onClick={() => onSelect?.(selected ? null : placed.id)}
              role="button"
              aria-label={[node.label, statusText, elapsed, doing]
                .filter((part) => part !== null && part !== undefined && part !== "")
                .join(" — ")}
            >
              <rect
                x={placed.x}
                y={placed.y}
                width={placed.width}
                height={placed.height}
                rx={10}
                fill={STATUS_FILL[status]}
                stroke={selected ? "var(--primary)" : STATUS_STROKE[status]}
                strokeWidth={selected ? 2.5 : 1.5}
              />
              {status === "running" ? (
                <rect
                  x={placed.x}
                  y={placed.y}
                  width={placed.width}
                  height={placed.height}
                  rx={10}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  strokeDasharray="6 6"
                  className="animate-[dash_1.2s_linear_infinite]"
                >
                  <animate
                    attributeName="stroke-dashoffset"
                    from="24"
                    to="0"
                    dur="1s"
                    repeatCount="indefinite"
                  />
                </rect>
              ) : null}
              <text
                x={placed.x + 12}
                y={placed.y + 22}
                className="fill-foreground"
                style={{ fontSize: 12, fontWeight: 500 }}
              >
                {node.label.length > labelRoom
                  ? `${node.label.slice(0, labelRoom - 1)}…`
                  : node.label}
              </text>
              {execution ? (
                <text
                  x={placed.x + placed.width - 10}
                  y={placed.y + 22}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  style={{ fontSize: 9 }}
                >
                  {shortModel(execution.model)}
                  <title>{`${execution.providerId} / ${execution.model}`}</title>
                </text>
              ) : null}
              <text
                x={placed.x + 12}
                y={placed.y + 40}
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                {KIND_LABEL[node.kind]}
                {node.kind === "subgraph" && node.graphId
                  ? ` ${node.graphId}`
                  : ""}
                {/* Two nodes with the same edges branch completely differently
                    under `every`, and the drawing alone cannot show it: the
                    arrows look identical. Said here, or the graph lies. */}
                {node.routing === "every" ? " · any match" : ""}
                {" · "}
                {statusText}
              </text>

              {/* The clock takes this corner from the visit limit while the
                  node runs: how long it has been going is the question being
                  asked right now, and how often it may go round is not. The
                  limit comes back the moment the node stops. */}
              {elapsed ? (
                <text
                  x={placed.x + placed.width - 10}
                  y={placed.y + 40}
                  textAnchor="end"
                  className="fill-foreground"
                  style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
                >
                  {elapsed}
                </text>
              ) : node.maxVisits > 1 ? (
                <text
                  x={placed.x + placed.width - 10}
                  y={placed.y + 40}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  style={{ fontSize: 10 }}
                >
                  max {node.maxVisits}×
                </text>
              ) : null}

              {/* Below the node, in the gap that holds the outgoing arrow: the
                  node itself is 56px of two full text lines, and making every
                  node taller for a line only running nodes ever show would
                  charge every graph in the library for it. Opaque, so it wins
                  against the arrow it crosses. */}
              {doing ? (
                <g>
                  <rect
                    x={placed.x + 4}
                    y={placed.y + placed.height + 3}
                    width={placed.width - 8}
                    height={16}
                    rx={8}
                    fill="var(--card)"
                    stroke="var(--primary)"
                    strokeOpacity={0.4}
                  />
                  <text
                    x={placed.x + placed.width / 2}
                    y={placed.y + placed.height + 14}
                    textAnchor="middle"
                    className="fill-muted-foreground"
                    style={{ fontSize: 9 }}
                  >
                    {doing.length > 30 ? `${doing.slice(0, 29)}…` : doing}
                    <title>{doing}</title>
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function CanvasLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="0" y1="4" x2="22" y2="4" stroke="var(--border)" strokeWidth="2" />
        </svg>
        always
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="22"
            y2="4"
            stroke="var(--border)"
            strokeWidth="2"
            strokeDasharray="5 4"
          />
        </svg>
        conditional
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="22"
            y2="4"
            stroke="var(--border)"
            strokeWidth="2"
            strokeDasharray="2 5"
          />
        </svg>
        possible handoff
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="0" y1="4" x2="22" y2="4" stroke="var(--primary)" strokeWidth="2" />
        </svg>
        Back edge (cycle)
      </span>
    </div>
  );
}
