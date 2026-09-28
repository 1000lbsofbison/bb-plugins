// Deterministic layered layout.
//
// A phase strip cannot draw a back edge — that limitation is exactly what this
// module exists to remove. Nodes are assigned to layers by longest path over
// forward edges only; back edges are then routed as arcs to the side, so a
// cycle is visible as a cycle instead of being hidden.
//
// Pure and dependency-free so the same code lays out a preview in the editor
// and a live run in the canvas, and so it can be unit tested without a DOM.
import {
  END_NODE,
  START_NODE,
  edgeKey,
  fanOutKey,
  handoffKey,
  handoffTargets,
  type Graph,
  type GraphEdge,
} from "./graph";

export const NODE_WIDTH = 172;
export const NODE_HEIGHT = 72;
/**
 * The vertical gap between two layers is not constant: it exists to hold the
 * arrow, and only a labelled arrow needs room for text. A uniform gap wide
 * enough for the widest caption made every plain arrow in the graph pay for
 * it, which is why an eight-layer graph used to be a thousand pixels of mostly
 * empty background.
 */
export const LAYER_GAP_TIGHT = 40;
export const LAYER_GAP_LABELLED = 92;
export const SIBLING_GAP = 24;
export const MARGIN = 28;

export type PlacedNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
};

export type PlacedEdge = {
  key: string;
  from: string;
  to: string;
  /** SVG path. Back edges bow out to the right so they never hide behind nodes. */
  path: string;
  isBack: boolean;
  labelX: number;
  labelY: number;
  label: string;
  conditional: boolean;
  /**
   * A target this edge may hand off to, rather than one it always takes. Drawn
   * differently because it is a different claim: the arrow says "can go here",
   * not "goes here".
   */
  candidate: boolean;
};

export type GraphLayout = {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
};

/**
 * Longest-path layering over forward edges. A back edge is any edge whose
 * target was already on the current DFS stack; excluding those keeps the
 * layering well-defined for cyclic graphs.
 */
function findBackEdges(graph: Graph): Set<string> {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const back = new Set<string>();
  const state = new Map<string, "open" | "closed">();

  const walk = (id: string) => {
    state.set(id, "open");
    for (const edge of outgoing.get(id) ?? []) {
      const seen = state.get(edge.to);
      if (seen === "open") {
        back.add(edgeKey(edge));
      } else if (seen === undefined) {
        walk(edge.to);
      }
    }
    state.set(id, "closed");
  };

  walk(START_NODE);
  for (const node of graph.nodes) if (!state.has(node.id)) walk(node.id);
  return back;
}

function assignLayers(graph: Graph, back: Set<string>): Map<string, number> {
  const forward = graph.edges.filter((edge) => !back.has(edgeKey(edge)));
  const layer = new Map<string, number>([[START_NODE, 0]]);

  // Relax repeatedly; bounded by node count, which is capped at 60.
  for (let pass = 0; pass <= graph.nodes.length + 1; pass += 1) {
    let changed = false;
    for (const edge of forward) {
      const from = layer.get(edge.from);
      if (from == null) continue;
      const want = from + 1;
      if ((layer.get(edge.to) ?? -1) < want) {
        layer.set(edge.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const node of graph.nodes) if (!layer.has(node.id)) layer.set(node.id, 1);

  // End always sits below everything that can reach it — but its own layer
  // must not count towards "everything", or the relaxation pass that already
  // placed it one below the last node pushes it one further and leaves an
  // empty row's worth of blank canvas above the End pill.
  const deepest = Math.max(
    ...[...layer.entries()]
      .filter(([id]) => id !== END_NODE)
      .map(([, index]) => index),
    0,
  );
  layer.set(END_NODE, deepest + 1);
  return layer;
}

/**
 * How tall each gap between two consecutive layers has to be. A gap only grows
 * when a forward edge parks its caption in it; `edgeLabel` is the single
 * source of truth for whether a caption exists, so the drawing and the space
 * reserved for it can never disagree.
 *
 * Back edges are routed down the right-hand lane and label themselves there,
 * so they never ask for vertical room.
 */
function gapsBetweenLayers(
  graph: Graph,
  layers: Map<string, number>,
  back: Set<string>,
  maxLayer: number,
): number[] {
  const gaps = new Array<number>(Math.max(maxLayer, 0)).fill(LAYER_GAP_TIGHT);
  for (const edge of graph.edges) {
    if (back.has(edgeKey(edge))) continue;
    if (edgeLabel(edge) === "") continue;
    const from = layers.get(edge.from);
    const to = layers.get(edge.to);
    if (from == null || to == null || to <= from) continue;
    // The caption sits at the middle of the edge, so that is the one gap that
    // has to hold it — a long edge spanning four layers does not need all four
    // widened.
    const middle = Math.min(Math.max(Math.floor((from + to - 1) / 2), from), to - 1);
    if (middle >= 0 && middle < gaps.length) {
      gaps[middle] = LAYER_GAP_LABELLED;
    }
  }
  return gaps;
}

/**
 * The edges the picture has, which is not quite the edges the graph has.
 *
 * A handoff edge reads its target from a field, so the one arrow the author
 * drew stands for several. Where the possible targets are declared — the enum
 * form — each becomes an arrow of its own, and the drawn one keeps its role as
 * the fallback. They are added before the layering rather than after it, so a
 * node that is only ever reached by a handoff still lands below the node that
 * hands off to it instead of floating at the top.
 */
function drawnEdges(graph: Graph): { edges: GraphEdge[]; candidates: Set<string> } {
  const edges = [...graph.edges];
  const candidates = new Set<string>();
  const taken = new Set(graph.edges.map(edgeKey));
  for (const edge of graph.edges) {
    for (const target of handoffTargets(graph, edge)) {
      // No label and no condition: the author wrote neither for this arrow,
      // and inheriting them would put the same caption on every candidate.
      const drawn: GraphEdge = {
        ...edge,
        to: target,
        label: "",
        when: null,
        handoffFrom: "",
      };
      const key = edgeKey(drawn);
      if (taken.has(key)) continue;
      taken.add(key);
      candidates.add(key);
      edges.push(drawn);
    }
  }
  return { edges, candidates };
}

export function layoutGraph(source: Graph): GraphLayout {
  const { edges: drawn, candidates } = drawnEdges(source);
  const graph: Graph = { ...source, edges: drawn };
  const back = findBackEdges(graph);
  const layers = assignLayers(graph, back);

  const ids = [START_NODE, ...graph.nodes.map((node) => node.id), END_NODE];
  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const index = layers.get(id) ?? 0;
    const list = byLayer.get(index) ?? [];
    list.push(id);
    byLayer.set(index, list);
  }

  const widest = Math.max(
    ...[...byLayer.values()].map((list) => list.length),
    1,
  );
  const contentWidth = widest * NODE_WIDTH + (widest - 1) * SIBLING_GAP;

  const maxLayer = Math.max(...[...layers.values()], 0);
  const gaps = gapsBetweenLayers(graph, layers, back, maxLayer);

  // Top edge of each layer, accumulated so a tight gap really costs less.
  const layerY: number[] = [MARGIN];
  for (let index = 0; index < maxLayer; index += 1) {
    layerY.push(layerY[index]! + NODE_HEIGHT + gaps[index]!);
  }

  const placed = new Map<string, PlacedNode>();
  for (const [index, list] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const rowWidth = list.length * NODE_WIDTH + (list.length - 1) * SIBLING_GAP;
    const startX = MARGIN + (contentWidth - rowWidth) / 2;
    list.forEach((id, column) => {
      placed.set(id, {
        id,
        x: startX + column * (NODE_WIDTH + SIBLING_GAP),
        y: layerY[index] ?? MARGIN,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        layer: index,
      });
    });
  }

  const width = contentWidth + MARGIN * 2 + 64; // room for back-edge arcs
  const height = (layerY[maxLayer] ?? MARGIN) + NODE_HEIGHT + MARGIN;

  const edges: PlacedEdge[] = graph.edges.flatMap((edge): PlacedEdge[] => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return [];
    const key = edgeKey(edge);
    const isBack = back.has(key);

    const fromX = from.x + from.width / 2;
    const toX = to.x + to.width / 2;

    if (isBack) {
      // Route around the right-hand side: down-out, up, back-in.
      const laneX = width - MARGIN / 2;
      const startY = from.y + from.height / 2;
      const endY = to.y + to.height / 2;
      const path = [
        `M ${from.x + from.width} ${startY}`,
        `C ${laneX} ${startY}, ${laneX} ${endY}, ${to.x + to.width} ${endY}`,
      ].join(" ");
      return [
        {
          key,
          from: edge.from,
          to: edge.to,
          path,
          isBack,
          labelX: laneX - 8,
          labelY: (startY + endY) / 2,
          label: edgeLabel(edge),
          conditional: edge.when !== null,
          candidate: candidates.has(key),
        },
      ];
    }

    const startY = from.y + from.height;
    const endY = to.y;
    const midY = (startY + endY) / 2;
    const path = [
      `M ${fromX} ${startY}`,
      `C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${endY}`,
    ].join(" ");
    return [
      {
        key,
        from: edge.from,
        to: edge.to,
        path,
        isBack,
        labelX: (fromX + toX) / 2,
        labelY: midY,
        label: edgeLabel(edge),
        conditional: edge.when !== null,
        candidate: candidates.has(key),
      },
    ];
  });

  return { nodes: [...placed.values()], edges, width, height };
}

/**
 * What an edge says on the canvas. A dynamic fan-out gets its own wording
 * because it is the one edge whose branch count is not visible in the drawing
 * — the reader would otherwise see a plain arrow and count one branch.
 */
export function edgeLabel(edge: GraphEdge): string {
  if (edge.label) return edge.label;
  if (fanOutKey(edge) !== "") return `per entry in ${fanOutKey(edge)}`;
  // The drawn arrow of a handoff is the fallback — the candidates are their
  // own arrows. Saying so is the only thing that keeps this from reading as
  // the ordinary "and then".
  if (handoffKey(edge) !== "") return "if no successor is named";
  return edge.when ? conditionLabel(edge) : "";
}

export function conditionLabel(edge: GraphEdge): string {
  if (!edge.when) return "";
  const { op, value, key } = edge.when;
  if (op === "always") return "otherwise";
  if (op === "visitsBelow") return `< ${value}×`;
  // The subject is named only when it is not the edge's own source, which is
  // the usual case; "on failure" on an arrow leaving the node that failed
  // reads better than repeating its id.
  if (op === "failed") return key ? `${key} failed` : "on failure";
  if (op === "succeeded") return key ? `${key} succeeded` : "on success";
  const target = key ? `${key} ` : "";
  const ops: Record<string, string> = {
    contains: "contains",
    notContains: "without",
    equals: "=",
    matches: "~",
  };
  return `${target}${ops[op] ?? op} ${value}`.trim();
}
