// The Crew plugin (`crew`) as seen from Graph Studio: the four calls of its
// RPC contract (crew docs §4.8) that a `member` node needs, and the check
// that a graph's members exist.
//
// Crew is optional. Graph Studio does not depend on it at build time — the
// contract is repeated here as zod schemas and reached through
// `bb.sdk.plugins.callRpc` — and a graph without member nodes never calls it.
// A graph *with* member nodes, however, must not run without it: the one
// wrong outcome is a member node that quietly becomes a fresh thread, so
// every failure here is an error with a sentence a person can act on.
import { z } from "zod";
import { memberNodes, type Graph, type GraphResolver } from "./graph";

export const CREW_PLUGIN_ID = "crew";
/** The contract version this code was written against. */
export const CREW_CONTRACT_VERSION = 1;

const memberSchema = z.object({
  memberId: z.string(),
  address: z.string(),
  crew: z.string(),
  key: z.string(),
  lead: z.boolean(),
  role: z.string(),
  threadId: z.string().nullable(),
  shift: z.number().nullable(),
  activity: z.string(),
});
export type CrewMember = z.infer<typeof memberSchema>;

const versioned = { contractVersion: z.number() };

export const crewSchemas = {
  resolveMember: z.object({
    ...versioned,
    member: memberSchema.nullable(),
    error: z.string().nullable(),
  }),
  sendToMember: z.object({
    ...versioned,
    messageId: z.string().nullable(),
    status: z.string(),
    duplicate: z.boolean(),
    error: z.string().nullable(),
  }),
  listMembers: z.object({ ...versioned, members: z.array(memberSchema) }),
  memberReply: z.object({
    ...versioned,
    status: z.enum(["pending", "held", "running", "completed", "failed", "refused"]),
    text: z.string().nullable(),
    eventCursor: z.number().nullable(),
    threadId: z.string().nullable(),
  }),
};

type Method = keyof typeof crewSchemas;

/** Narrow on purpose: `bb.sdk.plugins.callRpc` in production, a fake in tests. */
export type CallRpc = <T>(args: {
  pluginId: string;
  method: string;
  input: Record<string, string | number | boolean | null>;
  outputSchema: z.ZodType<T>;
  signal?: AbortSignal;
}) => Promise<T>;

/** Raised when Crew cannot be reached at all — not installed, disabled, crashed. */
export class CrewUnavailableError extends Error {}

/**
 * The id Crew deduplicates a delivery by: one per rerun generation, node,
 * visit and attempt of a run. The generation keeps a deliberate rerun from
 * a checkpoint from being answered with the earlier delivery's reply.
 */
export function memberCorrelationId(key: {
  runId: string;
  gen: number;
  nodeId: string;
  visit: number;
  attempt: number;
}): string {
  return `${key.runId}:${key.gen}:${key.nodeId}:${key.visit}:${key.attempt}`;
}

export function createCrewClient(callRpc: CallRpc) {
  async function call<M extends Method>(
    method: M,
    input: Record<string, string | number | boolean | null>,
    signal?: AbortSignal,
  ): Promise<z.infer<(typeof crewSchemas)[M]>> {
    let result: z.infer<(typeof crewSchemas)[M]>;
    try {
      result = (await callRpc({
        pluginId: CREW_PLUGIN_ID,
        method,
        input,
        outputSchema: crewSchemas[method] as unknown as z.ZodType<z.infer<(typeof crewSchemas)[M]>>,
        ...(signal ? { signal } : {}),
      })) as z.infer<(typeof crewSchemas)[M]>;
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CrewUnavailableError(
        `The Crew plugin ("${CREW_PLUGIN_ID}") is not installed or not reachable (${method}: ${reason}). Member nodes need it.`,
      );
    }
    // A newer contract may mean something else by the same field names;
    // refusing is better than misreading it.
    if (result.contractVersion !== CREW_CONTRACT_VERSION) {
      throw new CrewUnavailableError(
        `The Crew plugin speaks contract version ${result.contractVersion}; Graph Studio knows version ${CREW_CONTRACT_VERSION}. Update Graph Studio.`,
      );
    }
    return result;
  }

  return {
    resolveMember: (projectId: string, address: string) =>
      call("resolveMember", { projectId, address }),
    listMembers: (projectId: string) => call("listMembers", { projectId }),
    sendToMember: (input: {
      projectId: string;
      address: string;
      body: string;
      subject: string;
      correlationId: string;
    }) => call("sendToMember", { ...input, from: "graph-studio" }),
    memberReply: (messageId: string, signal?: AbortSignal) =>
      call("memberReply", { messageId }, signal),
  };
}

export type CrewClient = ReturnType<typeof createCrewClient>;

/**
 * Why a graph's member nodes cannot run, as ready sentences; empty when they
 * can (or when the graph has none — then Crew is not even asked).
 *
 * Without a project only Crew's presence can be checked: a member address is
 * only meaningful inside one project's crews. Every call is fail-closed,
 * unlike the model check — a member node has no sensible fallback.
 */
export async function memberProblems(
  graph: Graph,
  resolve: GraphResolver,
  crew: CrewClient,
  projectId: string | null,
): Promise<string[]> {
  const nodes = memberNodes(graph, resolve).filter((node) => node.member.trim() !== "");
  if (nodes.length === 0) return [];
  try {
    if (!projectId) {
      // Any project id will do to learn whether Crew answers at all.
      await crew.listMembers("-");
      return [];
    }
    const problems: string[] = [];
    for (const node of nodes) {
      const address = node.member.trim();
      const found = await crew.resolveMember(projectId, address);
      if (!found.member) {
        problems.push(
          `"${node.label}" names the member "${address}", which Crew does not know in this project${found.error ? ` (${found.error})` : ""}`,
        );
      } else if (!found.member.threadId) {
        problems.push(
          `"${node.label}" names the member "${address}", which has no thread yet; apply the crew first`,
        );
      }
    }
    return problems;
  } catch (cause) {
    return [cause instanceof Error ? cause.message : String(cause)];
  }
}
