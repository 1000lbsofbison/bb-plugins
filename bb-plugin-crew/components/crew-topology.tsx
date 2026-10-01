// Topology tab (§4.6): React Flow over lib/topology.ts, like Graph Studio's
// canvas. Groups are areas, members are nodes coloured by activity, links are
// drawn by kind. Clicking a node picks the member card on the right;
// double-clicking opens the member's thread. Nodes are not draggable: the
// layout is computed, see lib/topology.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ActivityDto, MemberDto } from "../server";
import { activityLabel, activityTone, HANDLE_OFFSET, layoutTopology, LINK_STYLE, NODE_H, NODE_W, type PlacedLink } from "../lib/topology";
import { Button } from "@/components/ui/button";

type MemberNodeData = { member: MemberDto; view: ActivityDto | null; selected: boolean };

function shortModel(model: string | null): string {
  if (!model) return "?";
  return (model.split("/").pop() ?? model).replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// Two handles per side: forward links at HANDLE_OFFSET.forward, return links
// at .reverse (lib/topology.ts routeLink), so a pair A→B / B→A stays apart.
const HANDLES: { id: string; type: "source" | "target"; position: Position; offset: number }[] = [
  { id: "in-left", type: "target", position: Position.Left, offset: HANDLE_OFFSET.forward },
  { id: "out-right", type: "source", position: Position.Right, offset: HANDLE_OFFSET.forward },
  { id: "out-left", type: "source", position: Position.Left, offset: HANDLE_OFFSET.reverse },
  { id: "in-right", type: "target", position: Position.Right, offset: HANDLE_OFFSET.reverse },
  { id: "in-top", type: "target", position: Position.Top, offset: HANDLE_OFFSET.forward },
  { id: "out-bottom", type: "source", position: Position.Bottom, offset: HANDLE_OFFSET.forward },
  { id: "out-top", type: "source", position: Position.Top, offset: HANDLE_OFFSET.reverse },
  { id: "in-bottom", type: "target", position: Position.Bottom, offset: HANDLE_OFFSET.reverse },
];

function MemberNode({ data }: NodeProps<Node<MemberNodeData>>) {
  const { member, view, selected } = data;
  const needs = (view?.needsYou.length ?? 0) > 0;
  const tone = activityTone(view?.activity ?? "unknown", needs);
  return (
    <div
      data-member-node={member.key}
      data-activity={needs ? "needs-you" : (view?.activity ?? "unknown")}
      className="flex h-full flex-col justify-center gap-0.5 rounded-[10px] border px-3"
      style={{
        borderColor: selected ? "#e6e6e6" : needs ? "#ef6b6b" : "#2a2a2e",
        background: needs ? "#1c1011" : "#0b0b0c",
      }}
    >
      {HANDLES.map((handle) => {
        const vertical = handle.position === Position.Left || handle.position === Position.Right;
        return (
          <Handle
            key={handle.id}
            id={handle.id}
            type={handle.type}
            position={handle.position}
            isConnectable={false}
            className="!size-1 !min-h-0 !min-w-0 !border-0 !opacity-0"
            style={vertical ? { top: `${handle.offset}%` } : { left: `${handle.offset}%` }}
          />
        );
      })}
      <div className="flex items-center gap-1.5 truncate text-[13px] font-medium leading-4 text-foreground">
        <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: tone }} />
        {member.lead ? "★ " : ""}
        {member.key}
      </div>
      {/* Status first, then shift, then model; wraps to a second line instead of cutting "Shift N" off. */}
      <div data-member-meta className="line-clamp-2 break-words pl-3.5 text-[11px] leading-4" style={{ color: needs ? "#ef6b6b" : "#8b8b90" }}>
        {activityLabel(view, member.thread)}
        {member.shift !== null ? ` · Shift ${member.shift}` : ""} · {shortModel(member.model)}
      </div>
    </div>
  );
}

/** One subtle area per group. Not React Flow's built-in "group" type, whose default frame would draw a second box. */
function GroupArea({ data }: NodeProps<Node<{ label: string }>>) {
  return (
    <div data-group-area={data.label} className="h-full w-full rounded-xl border border-[#1f1f22] bg-[#0b0b0c66]">
      <div className="px-3 pt-2 text-[11px] uppercase tracking-wide text-[#5c5c62]">group {data.label}</div>
    </div>
  );
}

export const nodeTypes = { member: MemberNode, crewGroup: GroupArea };

/** React Flow edges for the placed links: one per link, no text label (the legend names the kinds). */
export function toEdges(links: readonly PlacedLink[]): Edge[] {
  return links.map((link) => {
    const style = LINK_STYLE[link.kind] ?? LINK_STYLE.works_with!;
    return {
      id: link.id,
      source: link.from,
      target: link.to,
      sourceHandle: link.sourceHandle,
      targetHandle: link.targetHandle,
      type: "default",
      ariaLabel: `${link.from} ${style.label} ${link.to}`,
      data: { kind: link.kind, reverse: link.reverse },
      style: { stroke: style.stroke, strokeDasharray: style.dash, strokeWidth: 1.5 },
      markerEnd: style.arrow ? { type: MarkerType.ArrowClosed, color: style.stroke, width: 16, height: 16 } : undefined,
    };
  });
}

const FIT_VIEW = { padding: 0.15, maxZoom: 1 } as const;

/** Fits the graph once measured and again whenever the canvas changes size. */
function FitOnResize({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  const flow = useReactFlow();
  const nodesReady = useNodesInitialized();
  useEffect(() => {
    if (nodesReady) void flow.fitView(FIT_VIEW);
  }, [nodesReady, flow]);
  useEffect(() => {
    const element = target.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => void flow.fitView(FIT_VIEW));
    observer.observe(element);
    return () => observer.disconnect();
  }, [flow, target]);
  return null;
}

export function TopologyCanvas({
  members,
  links,
  activity,
  selected,
  onSelect,
  onOpen,
}: {
  members: MemberDto[];
  links: { from: string; to: string; kind: string }[];
  activity: ActivityDto[];
  selected: string | null;
  onSelect: (key: string) => void;
  onOpen?: (key: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const views = useMemo(() => new Map(activity.map((view) => [view.key, view])), [activity]);
  const { nodes, edges } = useMemo(() => {
    const layout = layoutTopology(
      members.map((member) => ({ key: member.key, groupId: member.groupId || member.key.split("-")[0]!, lead: member.lead })),
      links,
    );
    const byKey = new Map(members.map((member) => [member.key, member]));
    const nodes: Node[] = [
      ...layout.groups.map((group) => ({
        id: `group:${group.id}`,
        type: "crewGroup",
        position: { x: group.x, y: group.y },
        data: { label: group.id },
        style: { width: group.width, height: group.height },
        width: group.width,
        height: group.height,
        selectable: false,
        draggable: false,
      })),
      ...layout.members.map((placed) => ({
        id: placed.key,
        type: "member",
        parentId: `group:${placed.groupId}`,
        extent: "parent" as const,
        position: { x: placed.x, y: placed.y },
        width: NODE_W,
        height: NODE_H,
        style: { width: NODE_W, height: NODE_H },
        draggable: false,
        data: { member: byKey.get(placed.key)!, view: views.get(placed.key) ?? null, selected: placed.key === selected },
      })),
    ];
    return { nodes, edges: toEdges(layout.links) };
  }, [members, links, views, selected]);

  return (
    <div
      ref={box}
      className="relative h-[calc(100vh-240px)] min-h-[420px] min-w-0 flex-1 rounded-xl border border-[#1f1f22] bg-black"
      aria-label="Topology"
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={FIT_VIEW}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          style={{ background: "transparent" }}
          onNodeClick={(_event, node) => node.type === "member" && onSelect(node.id)}
          onNodeDoubleClick={(_event, node) => node.type === "member" && onOpen?.(node.id)}
        >
          <FitOnResize target={box} />
        </ReactFlow>
      </ReactFlowProvider>
      {/* The same links as text: React Flow draws edges only after measuring, and screen readers need them anyway. */}
      <ul className="sr-only" aria-label="Links">
        {links.map((link) => (
          <li key={`${link.from}-${link.to}-${link.kind}`} data-link-kind={link.kind}>
            {link.from} {link.kind} {link.to}
          </li>
        ))}
      </ul>
      <ul className="absolute bottom-2 left-3 flex gap-3 text-[11px] text-muted-foreground" aria-label="Legend">
        {Object.entries(LINK_STYLE).map(([kind, style]) => (
          <li key={kind} className="flex items-center gap-1">
            <svg width="18" height="6" aria-hidden>
              <line x1="0" y1="3" x2="18" y2="3" stroke={style.stroke} strokeDasharray={style.dash} strokeWidth="1.5" />
            </svg>
            {style.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export type MemberAction = "open" | "handover" | "reset-clear" | "reset-new" | "detach";

/** Reset as a split button: the main part clears the context, the chevron offers a fresh thread. */
function ResetSplit({ disabled, onAction }: { disabled: boolean; onAction: (action: MemberAction) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-flex">
      <Button size="sm" variant="outline" className="h-7 rounded-r-none" disabled={disabled} onClick={() => onAction("reset-clear")}>
        Reset
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 rounded-l-none border-l-0 px-1.5"
        disabled={disabled}
        aria-label="More reset options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ▾
      </Button>
      {open && !disabled ? (
        <div role="menu" className="absolute right-0 top-8 z-10 flex min-w-[180px] flex-col rounded-lg border border-[#1f1f22] bg-[#0b0b0c] p-1 text-xs shadow-lg">
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => (setOpen(false), onAction("reset-clear"))}>
            Reset (clear context)
          </button>
          <button type="button" role="menuitem" className="rounded px-2 py-1.5 text-left hover:bg-[#1a1a1c]" onClick={() => (setOpen(false), onAction("reset-new"))}>
            Reset (new thread)
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MemberCard({
  member,
  view,
  crewName,
  onAction,
  onAnswer,
}: {
  member: MemberDto;
  view: ActivityDto | null;
  crewName: string;
  onAction: (action: MemberAction) => void;
  onAnswer: (body: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const needs = (view?.needsYou.length ?? 0) > 0;
  // A BB interaction (approval, provider question) is answered in the thread; a crew_send question here.
  const inThread = view?.needsYou.some((reason) => reason === "approval" || reason === "question") ?? false;
  return (
    <aside aria-label="Member card" className="w-[300px] flex-none rounded-xl border border-[#1f1f22] bg-[#0b0b0c] p-4 text-xs">
      <h3 className="m-0 text-sm font-semibold">{member.key}</h3>
      <div className="mb-3 text-muted-foreground">
        {member.address}
        {member.shift !== null ? ` · Shift ${member.shift}` : ""}
      </div>
      {needs ? (
        <div className="mb-3 rounded-lg border border-[#3a1f22] bg-[#1c1011] p-2.5" data-needs-you="true">
          <b className="mb-1 block text-[#ef6b6b]">Needs you: {view!.needsYou.join(", ")}</b>
          {view!.question ? <p className="m-0 whitespace-pre-wrap">{view!.question}</p> : null}
          {inThread ? (
            <Button size="sm" variant="outline" className="mt-2 h-7" onClick={() => onAction("open")}>
              Answer in thread
            </Button>
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              <textarea
                aria-label="Answer"
                className="h-16 w-full resize-y rounded-md border border-[#1f1f22] bg-transparent p-1.5"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  className="h-7"
                  disabled={busy || answer.trim() === ""}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onAnswer(answer);
                      setAnswer("");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Send answer
                </Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => onAction("open")}>
                  Answer in thread
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      <dl className="mb-3 grid grid-cols-[90px_1fr] gap-x-2.5 gap-y-1.5">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="m-0">
          {member.provider ?? "?"} · {shortModel(member.model)}
        </dd>
        <dt className="text-muted-foreground">Permissions</dt>
        <dd className={member.permissions === "full" ? "m-0 text-[#ef6b6b]" : "m-0"}>{member.permissions ?? "?"}</dd>
        <dt className="text-muted-foreground">Thread</dt>
        <dd className="m-0">{member.thread === "present" ? (member.status ?? "?") : member.thread}</dd>
        <dt className="text-muted-foreground">Context</dt>
        <dd className="m-0">{view?.context !== null && view?.context !== undefined ? `${Math.round(view.context * 100)}%` : "–"}</dd>
        <dt className="text-muted-foreground">Queue</dt>
        <dd className="m-0">
          {view?.openWork ?? 0} open{view && view.held > 0 ? ` · ${view.held} held` : ""}
        </dd>
        {view && view.diagnoses.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Diagnosis</dt>
            <dd className="m-0 text-[#d9a441]">{view.diagnoses.join(" · ")}</dd>
          </>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" className="h-7" disabled={!member.threadId} onClick={() => onAction("open")}>
          Open
        </Button>
        <Button size="sm" variant="outline" className="h-7" disabled={!member.threadId} onClick={() => onAction("handover")}>
          Handover
        </Button>
        <ResetSplit disabled={!member.threadId} onAction={onAction} />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Click a node to switch the card · double-click opens the thread · {crewName}
      </p>
    </aside>
  );
}
