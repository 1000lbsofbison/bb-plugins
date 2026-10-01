// Messaging rules (§3.4, §3.9): who may write to whom, and when a chain is a
// loop. Pure functions over plain values, so every rule is tested on its own;
// `delivery.ts` feeds them from the store.
import { validateCrew, type CrewSpec, type ResolvedMember } from "./spec";
import type { CrewRow, MemberRow, Store } from "./store";

export type CrossCrew = CrewSpec["crossCrew"];
export type CrewPolicy = {
  name: string;
  messaging: CrewSpec["messaging"];
  crossCrew: CrossCrew;
  maxSteps: number;
  maxMessagesPerChainPerHour: number;
};

export const DEFAULT_POLICY: Omit<CrewPolicy, "name"> = {
  messaging: "open",
  crossCrew: "leads",
  maxSteps: 6,
  maxMessagesPerChainPerHour: 20,
};

export type CrewModel = { spec: CrewSpec | null; members: ResolvedMember[]; policy: CrewPolicy };

/**
 * The stored crew file of a crew, validated once per file version. The crew
 * file is the only place the policy lives; a crew without a readable file
 * falls back to the defaults of §3.4 rather than to "anything goes".
 */
export function createCrewModels(store: Store) {
  const cache = new Map<string, CrewModel>();
  return (crew: CrewRow): CrewModel => {
    const key = `${crew.id}:${crew.fileVersion}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const file = store.crewFile(crew.id);
    const validation = file ? validateCrew(file.yaml, { confirmFull: true }) : null;
    const spec = validation?.spec ?? null;
    const model: CrewModel = {
      spec,
      members: validation?.members ?? [],
      policy: spec
        ? {
            name: crew.name,
            messaging: spec.messaging,
            crossCrew: spec.crossCrew,
            maxSteps: spec.maxSteps,
            maxMessagesPerChainPerHour: spec.maxMessagesPerChainPerHour,
          }
        : { name: crew.name, ...DEFAULT_POLICY },
    };
    cache.set(key, model);
    return model;
  };
}
export type CrewModels = ReturnType<typeof createCrewModels>;

export type Party =
  | { kind: "human" }
  | { kind: "system" }
  | { kind: "member"; member: MemberRow; crew: CrewRow; policy: CrewPolicy };

const STRICTNESS: Record<CrossCrew, number> = { none: 0, leads: 1, open: 2 };

/** Between two crews the stricter setting wins: either crew can close its side. */
export function effectiveCrossCrew(a: CrossCrew, b: CrossCrew): CrossCrew {
  return STRICTNESS[a] <= STRICTNESS[b] ? a : b;
}

/**
 * Why `from` may not write to `to`, or null when it may. The human (and the
 * plugin itself) may always write, and anyone may write to the human — also
 * under `crossCrew: none` (§3.4, decided 30.09.2026).
 */
export function routeRefusal(
  from: Party,
  to: Party,
  links: readonly { from: string; to: string }[],
): string | null {
  if (from.kind !== "member" || to.kind !== "member") return null;
  if (from.crew.id === to.crew.id) {
    if (from.policy.messaging !== "links") return null;
    if (from.member.lead || to.member.lead) return null;
    const linked = links.some(
      (link) =>
        (link.from === from.member.key && link.to === to.member.key) ||
        (link.from === to.member.key && link.to === from.member.key),
    );
    return linked
      ? null
      : `messaging: links — there is no link between ${from.member.key} and ${to.member.key}. Write to your lead or to a linked member.`;
  }
  const rule = effectiveCrossCrew(from.policy.crossCrew, to.policy.crossCrew);
  if (rule === "open") return null;
  if (rule === "none") {
    return `crossCrew: none — crews ${from.crew.name} and ${to.crew.name} do not message each other. Ask the human (to: "human") instead.`;
  }
  if (from.member.lead && to.member.lead) return null;
  return `crossCrew: leads — only leads talk across crews. ${
    from.member.lead ? `Write to the lead of ${to.crew.name} instead.` : "Ask your lead to pass it on."
  }`;
}

/**
 * Loop protection: the message that would reach `maxSteps` is not delivered,
 * nor any message beyond the hourly cap of its chain, nor anything on a chain
 * that was stopped before.
 */
export function loopVerdict(args: {
  step: number;
  maxSteps: number;
  /** Messages of the chain in the last hour, the new one not counted. */
  chainCountLastHour: number;
  maxPerHour: number;
  chainStopped: string | null;
}): string | null {
  if (args.chainStopped !== null) return `chain stopped: ${args.chainStopped}`;
  if (args.step >= args.maxSteps) return `step ${args.step} reached maxSteps ${args.maxSteps}`;
  if (args.chainCountLastHour >= args.maxPerHour) {
    return `${args.chainCountLastHour} messages on this chain in the last hour (maxMessagesPerChainPerHour ${args.maxPerHour})`;
  }
  return null;
}
