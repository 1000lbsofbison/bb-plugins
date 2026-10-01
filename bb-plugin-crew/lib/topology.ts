// Topology tab (§4.6): groups as areas, members as nodes, links by kind.
//
// Positions are computed, not stored — like Graph Studio's canvas: a crew
// file has no coordinates, so a dragged node would snap back on the next
// change. Groups sit side by side in file order, the lead's group first;
// members stack inside their group. Pure, so the layout is tested without a DOM.
export const NODE_W = 184;
export const NODE_H = 58;
const PAD = 16;
const HEAD = 30;
const GAP_Y = 14;
const GAP_X = 48;

export type TopologyMember = { key: string; groupId: string; lead: boolean };
export type TopologyLink = { from: string; to: string; kind: string };

export type PlacedGroup = { id: string; x: number; y: number; width: number; height: number };
export type PlacedMember = { key: string; groupId: string; x: number; y: number };
/**
 * Handle ids on a member node. Links along the layout (left to right, or
 * down within a group) leave and enter at one offset, links against it at
 * another, so A→B and B→A never share a path — and a return link runs
 * between the cards instead of looping around them.
 */
export type SourceHandle = "out-right" | "out-left" | "out-bottom" | "out-top";
export type TargetHandle = "in-left" | "in-right" | "in-top" | "in-bottom";
export type PlacedLink = TopologyLink & { id: string; sourceHandle: SourceHandle; targetHandle: TargetHandle; reverse: boolean };

/** Offsets along the node side, in percent: forward links at one, return links at the other. */
export const HANDLE_OFFSET = { forward: 35, reverse: 65 } as const;

export const LINK_STYLE: Record<string, { stroke: string; dash?: string; arrow: boolean; label: string }> = {
  assigns_to: { stroke: "#7aa2ff", arrow: true, label: "assigns" },
  works_with: { stroke: "#8b8b90", dash: "5 4", arrow: false, label: "works with" },
  escalates_to: { stroke: "#ef6b6b", dash: "3 3", arrow: true, label: "escalates" },
  can_read: { stroke: "#4cc38a", dash: "1 4", arrow: true, label: "can read" },
};

export function layoutTopology(members: readonly TopologyMember[], links: readonly TopologyLink[]) {
  const order: string[] = [];
  const lead = members.find((member) => member.lead);
  if (lead) order.push(lead.groupId);
  for (const member of members) if (!order.includes(member.groupId)) order.push(member.groupId);

  const groups: PlacedGroup[] = [];
  const placed: PlacedMember[] = [];
  let x = 0;
  for (const groupId of order) {
    const inGroup = members.filter((member) => member.groupId === groupId).sort((a, b) => Number(b.lead) - Number(a.lead));
    const height = HEAD + inGroup.length * NODE_H + (inGroup.length - 1) * GAP_Y + PAD;
    groups.push({ id: groupId, x, y: 0, width: NODE_W + 2 * PAD, height });
    inGroup.forEach((member, index) => placed.push({ key: member.key, groupId, x: PAD, y: HEAD + index * (NODE_H + GAP_Y) }));
    x += NODE_W + 2 * PAD + GAP_X;
  }
  const known = new Set(members.map((member) => member.key));
  const edges: PlacedLink[] = links
    .filter((link) => known.has(link.from) && known.has(link.to))
    .map((link) => ({ ...link, id: `${link.from}->${link.to}:${link.kind}`, ...routeLink(link, placed, groups) }));
  return { groups, members: placed, links: edges };
}

/** Which sides a link uses: across groups by x, inside a group by y. */
export function routeLink(
  link: TopologyLink,
  placed: readonly PlacedMember[],
  groups: readonly PlacedGroup[],
): { sourceHandle: SourceHandle; targetHandle: TargetHandle; reverse: boolean } {
  const from = placed.find((member) => member.key === link.from);
  const to = placed.find((member) => member.key === link.to);
  const gx = (member: PlacedMember | undefined) => groups.find((group) => group.id === member?.groupId)?.x ?? 0;
  if (from && to && from.groupId === to.groupId) {
    const reverse = to.y < from.y;
    return reverse
      ? { sourceHandle: "out-top", targetHandle: "in-bottom", reverse }
      : { sourceHandle: "out-bottom", targetHandle: "in-top", reverse };
  }
  const reverse = gx(to) < gx(from);
  return reverse ? { sourceHandle: "out-left", targetHandle: "in-right", reverse } : { sourceHandle: "out-right", targetHandle: "in-left", reverse };
}

/**
 * What a member is doing, in one word. Activity is only known for a live
 * thread, so for an archived or missing one the thread axis says more than
 * "unknown" does.
 */
export function activityLabel(view: { activity: string; thread: string; needsYou: readonly string[] } | null, fallback: string): string {
  if (!view) return fallback;
  if (view.needsYou.length > 0) return "needs you";
  if (view.thread === "archived") return "archived";
  if (view.thread === "missing") return "no thread";
  return view.activity;
}

/** Node colour by activity; Needs you wins over everything else. */
export function activityTone(activity: string, needsYou: boolean): string {
  if (needsYou) return "#ef6b6b";
  switch (activity) {
    case "working":
      return "#d9a441";
    case "idle":
      return "#8b8b90";
    case "error":
      return "#ef6b6b";
    default:
      return "#3a3a3e";
  }
}
