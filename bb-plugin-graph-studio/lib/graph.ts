// The graph model.
//
// A graph is data, not code. It is authored in the UI, stored as JSON, and
// compiled to a LangGraph StateGraph at run time. Keeping it declarative buys
// three things: it can be drawn before it runs, it can be validated before it
// spawns a single thread, and a condition can never execute arbitrary code.
import { z } from "zod";

export const START_NODE = "__start__";
export const END_NODE = "__end__";

/**
 * `{{name}}` — the whole interpolation language. Shared by `renderPrompt` and
 * the validator on purpose: if the two ever read placeholders differently, the
 * validator blesses a prompt the runtime then renders as literal braces.
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/* ── conditions ──────────────────────────────────────────────────────────
   A deliberately small, inspectable language. No eval, no expressions: a
   condition names a source, an operator, and a literal. Anything it cannot
   express belongs in an agent node's prompt instead. */

export const CONDITION_OPS = [
  "always",
  "contains",
  "notContains",
  "equals",
  "matches",
  "visitsBelow",
  "failed",
  "succeeded",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const CONDITION_SOURCES = ["output", "field"] as const;
export type ConditionSource = (typeof CONDITION_SOURCES)[number];

export const conditionSchema = z.object({
  /** `output` matches the raw text, `field` compares a declared result field. */
  source: z.enum(CONDITION_SOURCES).default("output"),
  /**
   * For `output`: the node id whose text is read (empty = the edge's source).
   * For `field`: `nodeId.fieldName`, or a bare `fieldName` on the source node.
   * For `failed` and `succeeded`: the node id whose outcome is asked about;
   * `source` and `value` are not read there.
   */
  key: z.string().max(64).default(""),
  op: z.enum(CONDITION_OPS).default("always"),
  value: z.string().max(500).default(""),
});
export type Condition = z.infer<typeof conditionSchema>;

/**
 * `list` exists for dynamic fan-out: it is the only declared shape that can
 * say "and there are n of these" in a way an edge may read. Without it the
 * number of branches would have to be parsed out of prose, which is the
 * substring trap the declared fields were introduced to end.
 */
export const FIELD_TYPES = ["string", "number", "boolean", "enum", "list"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * A declared result field. Text matching on a worker's prose is fragile — a
 * critic writing "not good enough" once ended a run early because a condition
 * searched for "ENOUGH". Declaring fields makes the worker answer in JSON and
 * lets conditions compare values instead of hunting for substrings.
 */
export const fieldSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,31}$/, "field name: lowercase, starts with a letter"),
  type: z.enum(FIELD_TYPES).default("string"),
  /** Allowed values for `enum`; ignored otherwise. */
  options: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  description: z.string().max(200).default(""),
});
export type GraphField = z.infer<typeof fieldSchema>;

/**
 * `dialog` is an agent node that is allowed to ask back. An `agent` node is
 * one shot: the worker goes idle and its last message is the result — so a
 * worker that asks a question has its question read as an answer, and the run
 * moves on without anyone having replied. Skills built around an interview
 * (`grilling`) need the turn to come back to the user, which is what this kind
 * does: question → `interrupt()` → the answer is sent into the same thread.
 */
/**
 * How a node picks among its outgoing edges.
 *
 * `first` is the exclusive choice the graph has always made: conditions are
 * tried in order and the first match wins. `every` is the inclusive or — every
 * edge whose condition holds is taken, and those branches run in parallel.
 *
 * It has to be declared rather than inferred, because the two are
 * indistinguishable from the edges alone: three `equals` conditions on one enum
 * field are mutually exclusive and mean `first`, three `contains` conditions on
 * free text may well all hold and mean `every`. Guessing would silently change
 * what every existing graph does.
 *
 * Note what `every` does NOT bring: the branches it opens cannot be
 * synchronised again. `joinSources` only recognises unconditional branches,
 * precisely because a branch that was not chosen never arrives and a join
 * waiting for it would hang. A node behind an `every` split is warned about
 * and runs once per branch.
 */
export const ROUTING_MODES = ["first", "every"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const NODE_KINDS = [
  "agent",
  "dialog",
  "human",
  "note",
  "subgraph",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** One place for the short German label, so canvas and panel cannot drift. */
export const KIND_LABEL: Record<NodeKind, string> = {
  agent: "Agent",
  dialog: "Dialogue",
  human: "Approval",
  note: "Note",
  subgraph: "Subgraph",
};

/**
 * Reasoning levels BB accepts on `threads.spawn`. Kept as a plain list rather
 * than a free string so an imported graph cannot carry a level the host will
 * reject only once a worker is already being created.
 */
export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const SERVICE_TIERS = ["default", "fast"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

export const nodeSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,47}$/, "id: lowercase, starts with a letter"),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(NODE_KINDS).default("agent"),
  /** Sent to the spawned thread. `{{input}}` and `{{node_id}}` interpolate. */
  prompt: z.string().max(8000).default(""),
  /**
   * BB skill ids the node's worker should apply. A skill is a reviewed,
   * reusable instruction set — naming one is usually better than re-writing
   * its rules into `prompt` by hand. The worker loads them itself (progressive
   * disclosure), so this stays cheap in context.
   */
  skills: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
  /** Declared result fields. Empty = the node's result is plain text. */
  fields: z.array(fieldSchema).max(12).default([]),
  /** Exclusive choice (`first`) or inclusive or (`every`). See ROUTING_MODES. */
  routing: z.enum(ROUTING_MODES).default("first"),
  /** Cycle guard. A node may not run more often than this in one run. */
  maxVisits: z.number().int().min(1).max(50).default(3),
  /**
   * `dialog` only: how many questions the node may put to the user before it
   * is asked to wrap up. An interview without a ceiling is how a graph run
   * turns into an evening.
   */
  maxTurns: z.number().int().min(1).max(50).default(12),
  /**
   * Attempts for ONE visit before the node counts as failed. A worker thread
   * can die for reasons that have nothing to do with the task — a provider
   * hiccup, an empty answer — and without a retry a single one of those ends
   * the whole run. Distinct from `maxVisits`, which counts how often the graph
   * legitimately comes back to this node.
   */
  maxAttempts: z.number().int().min(1).max(5).default(2),
  /**
   * What a node that has used up its attempts does to the run.
   *
   * `stop` — the default and what this model always did — ends the run. That
   * is right when there is nothing sensible to do without this node's result.
   *
   * `route` makes failure a routable outcome instead: the node records its
   * error, the graph carries on, and an edge with the `failed` condition
   * picks up the pieces. This is the behaviour-tree fallback — try, and if
   * that does not work, try the other thing — which was not expressible here
   * before, because a failed node had exactly one way out of the graph.
   *
   * Opt-in per node rather than a graph-wide setting, and `stop` by default,
   * because the alternative is the worse mistake: a run that walks past a
   * step that never happened, with an empty `{{node}}` where its result
   * should be, looks from the outside exactly like a run that worked.
   *
   * Only `agent` and `dialog` nodes honour it — they are the ones that spawn
   * a worker and can fail.
   */
  onError: z.enum(["stop", "route"]).default("stop"),
  /**
   * `subgraph` only: the graph embedded here. Its nodes run as part of this
   * run and share its state, so a later node can read their results with the
   * usual `{{node}}` placeholder — that sharing is the whole point, and the
   * reason node ids have to be unique across the boundary.
   */
  graphId: z.string().trim().max(48).default(""),
  /**
   * Optional explicit execution; unset inherits the parent thread. The four
   * fields are one decision, not four: BB only honours a model together with
   * the provider it belongs to, so half a selection is dropped rather than
   * applied. `nodeExecution` is the single place that judges that, and
   * `validateGraph` rejects a half-filled node instead of letting it look
   * routed and run on the inherited model.
   */
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  reasoningLevel: z.enum(REASONING_LEVELS).nullable().default(null),
  serviceTier: z.enum(SERVICE_TIERS).nullable().default(null),
});
export type GraphNode = z.infer<typeof nodeSchema>;

/** What a node hands to `threads.spawn`; null means "inherit the parent". */
export type NodeExecution = {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | null;
  serviceTier: ServiceTier | null;
};

/**
 * The node's explicit execution, or null when it inherits. Runtime, server and
 * UI all read this instead of the raw fields, so "what counts as a complete
 * selection" is decided once. Anything incomplete is caught by
 * `validateGraph`; here it can only mean a graph that was never validated.
 */
export function nodeExecution(node: GraphNode): NodeExecution | null {
  const providerId = (node.providerId ?? "").trim();
  const model = (node.model ?? "").trim();
  if (providerId === "" || model === "") return null;
  return {
    providerId,
    model,
    reasoningLevel: node.reasoningLevel,
    serviceTier: node.serviceTier,
  };
}

/**
 * What actually goes to `threads.spawn`. Separate from `NodeExecution` because
 * an inherited run has a provider but no model: the thread record BB hands back
 * carries `providerId` and nothing else.
 */
export type SpawnExecution = {
  providerId: string;
  /** Only set for an explicit selection; inherited runs let BB pick. */
  model: string | null;
  reasoningLevel: ReasoningLevel | null;
  serviceTier: ServiceTier | null;
  /**
   * Did the graph choose this, or did we copy it off the parent? Drives
   * `executionInputSources`, so BB does not file an inherited provider as a
   * deliberate choice.
   */
  explicit: boolean;
};

/**
 * The execution a spawn should carry.
 *
 * A node with no selection is documented as inheriting the parent thread — but
 * omitting `providerId` does *not* inherit anything. BB then falls back to the
 * remembered project default and finally to the provider catalog default, so
 * the same graph ran on `claude-code` in one run and on `pi` in the next, with
 * no way to tell from the graph which it would be. Naming the parent's
 * provider makes the promise true and the run reproducible.
 *
 * Returning null means "we genuinely know nothing" — only when there is no
 * parent provider either. Then BB's defaults are the honest answer.
 */
export function spawnExecution(
  execution: NodeExecution | null,
  parentProviderId: string | null,
): SpawnExecution | null {
  if (execution !== null) {
    return {
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: execution.serviceTier,
      explicit: true,
    };
  }
  const inherited = (parentProviderId ?? "").trim();
  if (inherited === "") return null;
  // Only the provider is inherited. Carrying over the parent's reasoning level
  // or tier would be guesswork: the thread record does not report them.
  return {
    providerId: inherited,
    model: null,
    reasoningLevel: null,
    serviceTier: null,
    explicit: false,
  };
}

/** Only these kinds spawn a worker, so only these can carry an execution. */
export function spawnsThread(node: GraphNode): boolean {
  return node.kind === "agent" || node.kind === "dialog";
}

export const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Unset = unconditional. Conditions are tried in order; first match wins. */
  when: conditionSchema.nullable().default(null),
  label: z.string().max(60).default(""),
  /**
   * Dynamic fan-out: `nodeId.fieldName` (or a bare `fieldName` on the edge's
   * source) naming a `list` field. The target runs once per element, in
   * parallel, each instance seeing its own element as `{{item}}`.
   *
   * Static fan-out — several unconditional edges — fixes the branch count when
   * the graph is drawn. That is wrong for every task whose width is only known
   * once something has run: "review each changed file" is 7 branches today and
   * 2 tomorrow.
   */
  fanOutOver: z.string().max(64).default(""),
  /**
   * Handoff: `nodeId.fieldName` (or a bare `fieldName` on the edge's source)
   * naming the field that says where to go. The worker chooses its successor
   * instead of the author drawing it — the one thing a swarm has that a
   * supervisor does not.
   *
   * `to` stays the declared destination and becomes the fallback: it is where
   * the run goes when the field names nothing, or names a node that does not
   * exist. So a handoff edge is never dangling, and the canvas always has a
   * solid arrow to draw.
   *
   * Two forms, and the difference is what the graph can still promise:
   *
   * - An **enum** field whose options are node ids declares the possible
   *   successors. The canvas draws them, and the check for unreachable nodes
   *   stays whole. This is the recommended form.
   * - A **string** field is the open swarm: any node, decided at run time.
   *   The price is that neither the drawing nor the reachability check can see
   *   where it goes, and `validateGraph` says so rather than leaving the hole
   *   silent.
   */
  handoffFrom: z.string().max(64).default(""),
});
export type GraphEdge = z.infer<typeof edgeSchema>;

export const graphSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]{0,47}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  /**
   * A real task this graph is for, in the user's own words. It exists because
   * a graph's name says what the machine does and its description says how —
   * neither answers "what do I type into it". It is also what the ready-made
   * CLI line offers, so a placeholder like "<task>" would teach nothing.
   */
  example: z.string().trim().max(200).default(""),
  nodes: z.array(nodeSchema).min(1).max(60),
  edges: z.array(edgeSchema).max(200),
  /** Global guard: total node executions before the run stops itself. */
  maxSteps: z.number().int().min(1).max(500).default(60),
  /**
   * Ceiling on one dynamic fan-out. Each element becomes its own BB thread, so
   * a worker that answers with 200 file names would otherwise spawn 200 of
   * them. Surplus elements are dropped with a warning rather than failing the
   * run: a truncated review is worth more than none.
   */
  maxFanOut: z.number().int().min(1).max(50).default(12),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
});
export type Graph = z.infer<typeof graphSchema>;

/* ── validation ─────────────────────────────────────────────────────────── */

export type GraphProblem = { level: "error" | "warning"; message: string };

/**
 * Structural check run before any thread is spawned. Cycles are explicitly
 * legal — that is the whole point of the graph over a DAG — so they are
 * reported as information, never as an error.
 */
/**
 * How the validator and the runtime reach other graphs. Passed in rather than
 * imported, because `lib/graph.ts` must stay free of the store — it is the one
 * file that has to be testable with nothing but a literal.
 */
export type GraphResolver = (id: string) => Graph | null;

/**
 * Every node id reachable from this graph, including those inside embedded
 * subgraphs, with the graph each came from. Returns `null` on a cycle across
 * graph boundaries, which the caller reports — following one here would not
 * terminate.
 */
export function reachableNodeIds(
  graph: Graph,
  resolve: GraphResolver,
  seen: string[] = [],
): Map<string, string> | null {
  if (seen.includes(graph.id)) return null;
  const trail = [...seen, graph.id];
  const ids = new Map<string, string>();
  for (const node of graph.nodes) {
    ids.set(node.id, graph.id);
    if (node.kind !== "subgraph") continue;
    const child = resolve(node.graphId);
    if (!child) continue;
    const nested = reachableNodeIds(child, resolve, trail);
    if (nested === null) return null;
    for (const [id, owner] of nested) {
      // First writer wins; the duplicate is reported by the caller, which has
      // the labels to say something useful about it.
      if (!ids.has(id)) ids.set(id, owner);
    }
  }
  return ids;
}

export function validateGraph(
  graph: Graph,
  resolve: GraphResolver = () => null,
  /**
   * Graph ids already on the way down, so validating an embedded graph cannot
   * recurse forever when two graphs embed each other. The circle itself is
   * reported as its own error; this only keeps the check terminating.
   */
  seen: string[] = [],
): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      problems.push({ level: "error", message: `Duplicate node id "${node.id}".` });
    }
    ids.add(node.id);
  }

  const known = (id: string) => ids.has(id) || id === START_NODE || id === END_NODE;
  for (const edge of graph.edges) {
    if (!known(edge.from)) {
      problems.push({ level: "error", message: `Edge from unknown node "${edge.from}".` });
    }
    if (!known(edge.to)) {
      problems.push({ level: "error", message: `Edge to unknown node "${edge.to}".` });
    }
  }

  const entries = graph.edges.filter((edge) => edge.from === START_NODE);
  if (entries.length === 0) {
    problems.push({ level: "error", message: "No entry: add an edge from Start." });
  }
  if (entries.length > 1) {
    problems.push({
      level: "error",
      message: "More than one edge leaves Start; a run has exactly one entry.",
    });
  }
  if (!graph.edges.some((edge) => edge.to === END_NODE)) {
    problems.push({
      level: "warning",
      message: "No edge reaches End; the run can only stop on a guard.",
    });
  }

  for (const node of graph.nodes) {
    const out = graph.edges.filter((edge) => edge.from === node.id);
    if (out.length === 0) {
      problems.push({
        level: "warning",
        message: `"${node.label}" has no outgoing edge and ends the run.`,
      });
    }
    // Several unconditional edges is not a mistake — it is a fan-out, and
    // LangGraph runs those branches in the same superstep. Mixing the two
    // styles on one node is a mistake, because then it is unclear whether the
    // author meant "branch to all" or "pick one".
    // Under `every` the mix is the point: an unconditional edge there means
    // "always this branch, plus whichever conditions hold".
    const conditional = out.filter((edge) => edge.when !== null);
    if (
      node.routing === "first" &&
      conditional.length > 0 &&
      conditional.length < out.length - 1
    ) {
      problems.push({
        level: "error",
        message: `"${node.label}" mixes conditional and several unconditional edges; keep at most one unconditional edge as the fallback.`,
      });
    }
    if (node.routing === "every" && out.length < 2) {
      problems.push({
        level: "warning",
        message: `"${node.label}" is set to "every matching branch" but has only ${out.length === 0 ? "no" : "one"} outgoing edge; the setting has no effect.`,
      });
    }
    if ((node.kind === "agent" || node.kind === "dialog") && node.prompt.trim() === "") {
      problems.push({
        level: "warning",
        message: `"${node.label}" has an empty prompt.`,
      });
    }
  }

  // A condition on a field that nobody declares would silently never match —
  // the same failure shape as the old substring sentinels, so it is an error.
  // Declared fields of every reachable node, embedded graphs included. Reading
  // a child's field from the parent is not an accident to be tolerated — it is
  // what shared state is for, and "concept done, now plan it" needs it.
  const declaredFields = (
    entry: Graph,
    // A → B → A is reported as its own error further down; carrying the trail
    // is what keeps *this* walk from recursing until the stack gives out.
    // Checking only for direct self-reference was not enough, as the test for
    // mutual embedding found out.
    seen: string[] = [],
  ): Array<[string, Map<string, GraphField>]> => {
    if (seen.includes(entry.id)) return [];
    const trail = [...seen, entry.id];
    return entry.nodes.flatMap((node) => {
      const own: Array<[string, Map<string, GraphField>]> = [
        [node.id, new Map(node.fields.map((field) => [field.name, field]))],
      ];
      if (node.kind !== "subgraph") return own;
      const child = resolve(node.graphId);
      if (!child) return own;
      return [...own, ...declaredFields(child, trail)];
    });
  };
  const declared = new Map(declaredFields(graph));
  for (const edge of graph.edges) {
    if (edge.when === null || edge.when.source !== "field") continue;
    // `failed` and `succeeded` read the node's outcome, so their key names a
    // node and not a field. Checking it against the declared fields would
    // reject a correct edge for a field it never meant to read.
    if (edge.when.op === "failed" || edge.when.op === "succeeded") continue;
    const key = edge.when.key.trim();
    const dot = key.indexOf(".");
    const nodeId = dot === -1 ? edge.from : key.slice(0, dot);
    const fieldName = dot === -1 ? key : key.slice(dot + 1);
    const known = declared.get(nodeId);
    if (!known) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} reads a field of "${nodeId}", which does not exist.`,
      });
      continue;
    }
    const field = known.get(fieldName);
    if (field === undefined) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} reads "${fieldName}", but "${nodeId}" does not declare that field.`,
      });
      continue;
    }
    // `parseFields` only ever writes a value that is one of `options`, so an
    // `equals` against anything else can never be true. The edge is drawn on
    // the canvas, looks routed, and silently never fires — the exact failure
    // shape the declared fields were introduced to end. Two vocabularies for
    // one verdict (APPROVE/REWORK vs TRAEGT/NACHSCHAERFEN) is how a cloned
    // template inherits one of these.
    if (
      field.type === "enum" &&
      field.options.length > 0 &&
      edge.when.op === "equals"
    ) {
      const wanted = edge.when.value.trim().toLowerCase();
      const hit = field.options.some(
        (option) => option.trim().toLowerCase() === wanted,
      );
      if (!hit) {
        problems.push({
          level: "error",
          message: `Edge ${edge.from} → ${edge.to} compares "${fieldName}" with "${edge.when.value}"; allowed are: ${field.options.join(", ")}.`,
        });
      }
    }
  }

  /* ── failure as a route ───────────────────────────────────────────────
     Both halves of the same trap. An edge that asks about a failure the node
     never records can never be taken, and a node that routes its failures
     nowhere walks past a step that did not happen — the first is an edge on
     the canvas that is decoration, the second is a run that looks finished
     and is not. */
  const routesFailure = (nodeId: string): boolean => {
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    if (!node) return false;
    return (
      node.onError === "route" && (node.kind === "agent" || node.kind === "dialog")
    );
  };
  for (const edge of graph.edges) {
    const op = edge.when?.op;
    if (op !== "failed" && op !== "succeeded") continue;
    const subject = edge.when!.key.trim() || edge.from;
    const node = graph.nodes.find((entry) => entry.id === subject);
    if (!node) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} asks whether "${subject}" failed, but there is no such node.`,
      });
      continue;
    }
    if (routesFailure(subject)) continue;
    const reason =
      node.kind === "agent" || node.kind === "dialog"
        ? `"${node.label}" ends the run when it fails`
        : `"${node.label}" is a ${KIND_LABEL[node.kind]} node and cannot fail`;
    problems.push(
      op === "failed"
        ? {
            level: "error",
            message: `Edge ${edge.from} → ${edge.to} is taken when "${node.label}" fails, but ${reason}; the edge can never be taken. Set that node to "route the failure".`,
          }
        : {
            level: "warning",
            message: `Edge ${edge.from} → ${edge.to} is taken when "${node.label}" succeeds, but ${reason}, so the condition always holds.`,
          },
    );
  }
  const fannedOut = new Set(
    graph.edges.filter((edge) => fanOutKey(edge) !== "").map((edge) => edge.to),
  );
  for (const node of graph.nodes) {
    if (node.onError !== "route") continue;
    if (node.kind !== "agent" && node.kind !== "dialog") {
      problems.push({
        level: "warning",
        message: `"${node.label}" is set to route its failure, but a ${KIND_LABEL[node.kind]} node spawns no worker and cannot fail; the setting has no effect.`,
      });
      continue;
    }
    // A node behind a dynamic fan-out is n nodes at once, and they do not
    // share an outcome: three of seven branches failing is neither "the node
    // failed" nor "the node succeeded", and whichever branch finished last
    // would decide. Refused rather than warned about, because the edge would
    // fire or not fire by timing.
    if (fannedOut.has(node.id)) {
      problems.push({
        level: "error",
        message: `"${node.label}" runs once per entry of a fan-out, so it has no single outcome to route on; it cannot route its failure.`,
      });
      continue;
    }
    const caught = graph.edges.some(
      (edge) =>
        edge.when?.op === "failed" && (edge.when.key.trim() || edge.from) === node.id,
    );
    if (!caught) {
      problems.push({
        level: "warning",
        message: `"${node.label}" routes its failure onward, but no edge asks whether it failed; a failed attempt would carry on as if the node had produced nothing.`,
      });
    }
  }

  for (const node of graph.nodes) {
    // A dialogue node answers with fields too — on its closing message, once
    // the interview is over.
    if (node.kind === "agent" || node.kind === "dialog") continue;
    if (node.fields.length > 0) {
      problems.push({
        level: "warning",
        message: `"${node.label}" is neither an agent nor a dialogue node; declared fields go unused.`,
      });
    }
  }

  /**
   * A prompt that forbids what the answer format demands. Every node that
   * answers with fields gets `fieldContract` appended, and a dialogue node
   * gets `DIALOG_CONTRACT` — both end the answer with a JSON block. A prompt
   * closing on "and nothing after" leaves the worker two instructions it
   * cannot both follow: drop the block and `parseFields` fails the node on
   * every attempt of the retry policy, or keep it and the sentence was a lie
   * whose block then travels on inside the result.
   *
   * Found in the shipped `concept-waves`, where the sentence was there for a
   * good reason — the node's output *is* the document. A warning rather than
   * an error: only the phrasing is wrong, and only the author can fix it.
   */
  const FORBIDS_TRAILING_TEXT =
    /nothing (?:comes )?after\b|no (?:further |other )?text after\b|nothing follows\b/i;
  for (const node of graph.nodes) {
    const answersInJson = node.kind === "dialog" || node.fields.length > 0;
    if (!answersInJson) continue;
    if (FORBIDS_TRAILING_TEXT.test(node.prompt)) {
      problems.push({
        level: "warning",
        message: `"${node.label}" tells the worker nothing may follow its answer, but its answer format ends with a JSON block; the node would fail its contract.`,
      });
    }
  }

  // Explicit execution. BB applies a model only together with its provider, so
  // half a selection is dropped on the way to `threads.spawn` — the node would
  // run on the inherited model while the editor and the export both show the
  // one that was picked. Same shape as every expensive bug in this project:
  // nothing crashes, it just never takes effect.
  for (const node of graph.nodes) {
    const providerId = (node.providerId ?? "").trim();
    const model = (node.model ?? "").trim();
    if (providerId !== "" && model === "") {
      problems.push({
        level: "error",
        message: `"${node.label}" names the provider "${providerId}" but no model; the node would run on the inherited model.`,
      });
    }
    if (model !== "" && providerId === "") {
      problems.push({
        level: "error",
        message: `"${node.label}" names the model "${model}" but no provider; a model on its own is discarded.`,
      });
    }
    // Reasoning level and service tier ride along with the pair. On their own
    // they are silently dropped, which would make a node look tuned when it
    // is not.
    if (providerId === "" || model === "") {
      for (const [label, value] of [
        ["reasoning level", node.reasoningLevel],
        ["service tier", node.serviceTier],
      ] as const) {
        if (value !== null) {
          problems.push({
            level: "error",
            message: `"${node.label}" sets the ${label} "${value}" without naming a provider and model; it is discarded.`,
          });
        }
      }
    }
    // A note documents, an approval node waits for a person — neither spawns a
    // worker, so there is nothing for a model to apply to.
    if (!spawnsThread(node) && (providerId !== "" || model !== "")) {
      problems.push({
        level: "warning",
        message: `"${node.label}" is a ${KIND_LABEL[node.kind]} node and starts no worker; the model choice goes unused.`,
      });
    }
  }

  // Subgraphs. A subgraph node embeds another graph into this run: its nodes
  // become part of the same LangGraph, share the same state, and an
  // `interrupt()` inside one suspends the whole run — which is exactly why it
  // is worth having, and exactly what makes the rules below necessary.
  for (const node of graph.nodes) {
    if (node.kind !== "subgraph") {
      if (node.graphId !== "") {
        problems.push({
          level: "warning",
          message: `"${node.label}" is not a subgraph node; the graph "${node.graphId}" entered here goes unused.`,
        });
      }
      continue;
    }
    if (node.graphId === "") {
      problems.push({
        level: "error",
        message: `"${node.label}" is a subgraph node but names no graph.`,
      });
      continue;
    }
    if (node.graphId === graph.id) {
      problems.push({
        level: "error",
        message: `"${node.label}" embeds its own graph; that would run forever.`,
      });
      continue;
    }
    const child = resolve(node.graphId);
    if (!child) {
      problems.push({
        level: "error",
        message: `"${node.label}" embeds the graph "${node.graphId}", which does not exist.`,
      });
      continue;
    }
    // A subgraph node is not a worker: the embedded graph's own nodes do the
    // work, and they read `{{input}}` and the results before them from the
    // shared state. A prompt here would look like an instruction and reach
    // nobody.
    if (node.prompt.trim() !== "") {
      problems.push({
        level: "warning",
        message: `"${node.label}" is a subgraph node and carries a prompt; nobody receives it. The nodes of "${node.graphId}" read {{input}} and the results of the nodes before them.`,
      });
    }
    if (node.fields.length > 0) {
      problems.push({
        level: "warning",
        message: `"${node.label}" is a subgraph node; declared fields go unused. Route on a field of a node INSIDE "${node.graphId}".`,
      });
    }
    // The child must be runnable on its own, or the run fails somewhere deep
    // inside a graph the author was not even looking at.
    if (seen.includes(child.id)) continue;
    const childProblems = validateGraph(child, resolve, [...seen, graph.id]).filter(
      (problem) => problem.level === "error",
    );
    if (childProblems.length > 0) {
      problems.push({
        level: "error",
        message: `Embedded graph "${child.name}" is not runnable itself: ${childProblems[0]!.message}`,
      });
    }
  }

  // A subgraph node writes nothing of its own into the state — its children
  // do, under their own ids. So a condition or a placeholder pointing at the
  // subgraph node reads an empty slot: the edge never fires, the placeholder
  // renders empty, and both look perfectly reasonable on the canvas.
  const subgraphIds = new Set(
    graph.nodes.filter((node) => node.kind === "subgraph").map((node) => node.id),
  );
  if (subgraphIds.size > 0) {
    for (const edge of graph.edges) {
      if (edge.when === null || edge.when.source !== "output") continue;
      const key = edge.when.key.trim() || edge.from;
      if (!subgraphIds.has(key)) continue;
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} reads the text of "${key}", a subgraph node; that writes nothing itself. Read a node INSIDE the embedded graph.`,
      });
    }
    for (const node of graph.nodes) {
      for (const [, name] of node.prompt.matchAll(PLACEHOLDER)) {
        if (!subgraphIds.has(name)) continue;
        problems.push({
          level: "error",
          message: `"${node.label}" reads {{${name}}}, a subgraph node; that writes nothing itself. Name a node from the embedded graph instead.`,
        });
      }
    }
  }

  // Shared state is the deal a subgraph makes: a later node can read
  // `{{node_in_child}}`. The price is that two nodes with the same id write
  // the same slot, and the second silently overwrites the first — with no
  // error anywhere, because each graph on its own is perfectly valid.
  const reachable = reachableNodeIds(graph, resolve);
  if (reachable === null) {
    problems.push({
      level: "error",
      message: "The embedded graphs reference each other in a circle.",
    });
  } else {
    for (const node of graph.nodes) {
      if (node.kind !== "subgraph") continue;
      const child = resolve(node.graphId);
      if (!child) continue;
      const childIds = reachableNodeIds(child, resolve);
      if (childIds === null) continue;
      for (const id of childIds.keys()) {
        if (!ids.has(id)) continue;
        problems.push({
          level: "error",
          message: `Node id "${id}" exists here and in "${child.name}"; embedded graphs share state, so the second value would overwrite the first.`,
        });
      }
    }
  }

  // Dynamic fan-out. The branch count comes from a declared `list` field, so
  // the same strictness applies as to conditions: a fan-out over a field
  // nobody declares, or over one that is not a list, would resolve to zero
  // branches and skip the work entirely without anything looking wrong.
  const fanOutTargets = new Set<string>();
  for (const edge of graph.edges) {
    const key = fanOutKey(edge);
    if (key === "") continue;
    fanOutTargets.add(edge.to);
    if (edge.when !== null) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} fans out and carries a condition; the two together are undefined.`,
      });
    }
    if (graph.edges.filter((entry) => entry.from === edge.from).length > 1) {
      problems.push({
        level: "error",
        message: `"${edge.from}" fans out over "${key}" and has further outgoing edges; a fanning node has exactly one.`,
      });
    }
    const dot = key.indexOf(".");
    const nodeId = dot === -1 ? edge.from : key.slice(0, dot);
    const fieldName = dot === -1 ? key : key.slice(dot + 1);
    const field = declared.get(nodeId)?.get(fieldName);
    if (field === undefined) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} fans out over "${key}", but that field is not declared.`,
      });
    } else if (field.type !== "list") {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} fans out over "${fieldName}", but that field is of type "${field.type}" instead of "list".`,
      });
    }
  }

  /* ── handoff: the edge's target read from a field ──────────────────────
     Same strictness as the fan-out above, for the same reason: the target is
     no longer visible in the drawing, so the only thing standing between "the
     worker picks the next node" and "the worker says something and the run
     quietly takes the fallback every time" is what is checked here. */
  for (const edge of graph.edges) {
    const key = handoffKey(edge);
    if (key === "") continue;
    if (fanOutKey(edge) !== "") {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} both fans out and hands off; an edge does one or the other.`,
      });
      continue;
    }
    // A node whose edges are all unconditional takes all of them, in the same
    // superstep. A handoff picks one. The runtime wires the first of those and
    // would ignore the field entirely, which is the silent kind of wrong.
    if (isFanOut(graph, edge.from)) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} hands off, but "${edge.from}" branches to all its targets at once; a handoff chooses one.`,
      });
      continue;
    }
    const dot = key.indexOf(".");
    const ownerId = dot === -1 ? edge.from : key.slice(0, dot);
    const fieldName = dot === -1 ? key : key.slice(dot + 1);
    const field = declared.get(ownerId)?.get(fieldName);
    if (field === undefined) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} takes its target from "${key}", but that field is not declared.`,
      });
      continue;
    }
    if (field.type !== "enum" && field.type !== "string") {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} takes its target from "${fieldName}", but that field is of type "${field.type}"; a target comes from a choice or a text.`,
      });
      continue;
    }
    if (field.type === "string") {
      // Allowed on purpose — this is the open swarm, where the successors are
      // not all drawn in advance. The warning is the price made visible: two
      // things this model otherwise guarantees stop holding for this edge.
      problems.push({
        level: "warning",
        message: `Edge ${edge.from} → ${edge.to} takes its target from the free text "${fieldName}"; the canvas cannot draw where it goes and the check for unreachable nodes cannot see it. An enum of node ids keeps both.`,
      });
      continue;
    }
    // The enum form promises that its options are the successors. An option
    // that names no node breaks exactly that promise, and the run would take
    // the fallback while the canvas drew an arrow that was never taken.
    const ids = new Set(graph.nodes.map((node) => node.id));
    const unknown = field.options.filter((option) => !ids.has(option.trim()));
    if (unknown.length > 0) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} takes its target from "${fieldName}", but ${unknown
          .map((option) => `"${option}"`)
          .join(", ")} ${unknown.length === 1 ? "names no node" : "name no nodes"} in this graph.`,
      });
    }
    if (field.options.length === 0) {
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} takes its target from "${fieldName}", but that choice declares no options; there is nothing it could hand off to.`,
      });
    }
  }

  for (const target of fanOutTargets) {
    const node = graph.nodes.find((entry) => entry.id === target);
    if (!node) continue;
    // A fan-out target that never reads `{{item}}` runs n identical threads —
    // the branches exist, but nothing distinguishes them.
    if (!/\{\{\s*item\s*\}\}/.test(node.prompt)) {
      problems.push({
        level: "warning",
        message: `"${node.label}" is the target of a fan-out but reads no {{item}}; every branch would get the same prompt.`,
      });
    }
    // A dialogue or approval node suspends the graph. n of them in parallel
    // would queue n interrupts on one user, and the turn-taking bookkeeping is
    // per node and visit — it cannot tell two concurrent interviews apart.
    // A subgraph is barred for the same reason one step removed: the embedded
    // graph may contain a dialogue or approval node, so n branches would queue
    // n interrupts on one person — and whether it does is not visible on this
    // edge.
    if (node.kind === "dialog" || node.kind === "human" || node.kind === "subgraph") {
      problems.push({
        level: "error",
        message: `"${node.label}" is a ${KIND_LABEL[node.kind]} node and cannot be the target of a fan-out.`,
      });
    }
    // Parallel branches have no single field value — each instance parsed its
    // own. An edge reading one would silently get whichever branch landed
    // last, so the fields of a fan-out target deliberately never reach the
    // state, and reading them is an error rather than a surprise.
    for (const edge of graph.edges) {
      if (edge.when === null || edge.when.source !== "field") continue;
      const key = edge.when.key.trim();
      const dot = key.indexOf(".");
      const nodeId = dot === -1 ? edge.from : key.slice(0, dot);
      if (nodeId !== target) continue;
      problems.push({
        level: "error",
        message: `Edge ${edge.from} → ${edge.to} reads a field of "${node.label}", which runs fanned out; the branches share no field value.`,
      });
    }
  }

  // Placeholders may name a node inside an embedded graph — same reason as the
  // declared fields above. `ids` alone would reject exactly the reference that
  // makes a subgraph useful.
  const knownNodeIds = new Set([
    ...ids,
    ...(reachable === null ? [] : reachable.keys()),
  ]);

  // `renderPrompt` leaves a placeholder it cannot resolve exactly as written,
  // so a typo does not fail — it ships `{{erkunden}}` to the worker as literal
  // text and the prompt quietly loses the context it was built around. Only
  // node ids resolve; catching the rest here is the only point where anyone
  // is still looking.
  for (const node of graph.nodes) {
    for (const [, name] of node.prompt.matchAll(PLACEHOLDER)) {
      // `{{item}}` only means something in a node the graph fans out into;
      // anywhere else it renders as the empty string and the prompt silently
      // loses whatever the author thought it referred to.
      if (name === "item") {
        if (!fanOutTargets.has(node.id)) {
          problems.push({
            level: "error",
            message: `"${node.label}" reads {{item}} but is not the target of a fan-out.`,
          });
        }
        continue;
      }
      // `{{node.field}}` reads a declared result field instead of the whole
      // text. Same trap as everywhere else in this file: an undeclared field
      // renders empty, the prompt looks complete, and the context the author
      // built it around is silently gone.
      const dot = name.indexOf(".");
      if (dot !== -1) {
        const sourceId = name.slice(0, dot);
        const fieldName = name.slice(dot + 1);
        const known = declared.get(sourceId);
        if (!known) {
          problems.push({
            level: "error",
            message: `"${node.label}" reads {{${name}}}, but there is no node "${sourceId}".`,
          });
        } else if (fieldName === "error" && !known.has("error")) {
          // `{{build.error}}` is why the node gave up, not a declared field —
          // and it only ever holds anything on a node that routes its failure.
          // On any other node it would render empty forever, which is the same
          // silent hole as an undeclared field.
          if (!routesFailure(sourceId)) {
            problems.push({
              level: "error",
              message: `"${node.label}" reads {{${name}}}, but "${sourceId}" ends the run when it fails, so it never leaves an error behind.`,
            });
          }
        } else if (!known.has(fieldName)) {
          problems.push({
            level: "error",
            message: `"${node.label}" reads {{${name}}}, but "${sourceId}" declares no field "${fieldName}".`,
          });
        } else if (fanOutTargets.has(sourceId)) {
          // Same reason an edge may not read one: each branch parsed its own
          // value, so there is no single one to render.
          problems.push({
            level: "error",
            message: `"${node.label}" reads {{${name}}} from a node that runs fanned out; the branches share no field value.`,
          });
        }
        continue;
      }
      if (name === "input" || knownNodeIds.has(name)) continue;
      problems.push({
        level: "error",
        message: `"${node.label}" writes {{${name}}}, but there is no node "${name}"; the placeholder would be left standing verbatim.`,
      });
    }
  }

  // Nodes that two branches of the same fan-out reach without being a
  // structured join. The engine starts a node as soon as *one* incoming edge
  // delivers, so such a node runs once per branch — and its first run reads a
  // state the other branches have not written yet. Measured on an unbalanced
  // fan-out before join edges existed: the join ran twice, the first time
  // before the longer branch had started. `joinSources` covers the structured
  // case; everything it refuses lands here as a warning rather than silently
  // running twice.
  const joins = joinGroups(graph);
  for (const node of graph.nodes) {
    if (!isFanOut(graph, node.id)) continue;
    const reachedBy = new Map<string, number>();
    for (const edge of graph.edges.filter((entry) => entry.from === node.id)) {
      for (const id of branchReach(graph, edge.to, joins)) {
        reachedBy.set(id, (reachedBy.get(id) ?? 0) + 1);
      }
    }
    for (const [id, count] of reachedBy) {
      if (count < 2 || joins.has(id)) continue;
      const target = graph.nodes.find((entry) => entry.id === id);
      problems.push({
        level: "warning",
        message: `"${target?.label ?? id}" is reached by several branches of "${node.label}" but does not count as a join; it then runs once per branch, the first time on an incomplete state. Make the branches equal in length, or leave every edge into it unconditional.`,
      });
    }
  }

  for (const id of reachableFromStart(graph)) ids.delete(id);
  for (const id of ids) {
    const node = graph.nodes.find((entry) => entry.id === id);
    problems.push({
      level: "warning",
      message: `"${node?.label ?? id}" is never reached from Start.`,
    });
  }

  return problems;
}

export function reachableFromStart(graph: Graph): Set<string> {
  const seen = new Set<string>();
  const queue = graph.edges
    .filter((edge) => edge.from === START_NODE)
    .map((edge) => edge.to);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === END_NODE || seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges.filter((entry) => entry.from === id)) {
      // A declared handoff candidate is reached the same as any target; that
      // is what the enum form buys, and why it is the recommended one.
      queue.push(...edgeTargets(graph, edge));
    }
  }
  return seen;
}

/**
 * Everything one fan-out branch reaches, stopping at structured joins: a join
 * already guarantees a single run, so what lies beyond it is entered once and
 * must not be counted per branch.
 */
function branchReach(
  graph: Graph,
  start: string,
  joins: Map<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === END_NODE || seen.has(id)) continue;
    seen.add(id);
    if (joins.has(id)) continue;
    for (const edge of graph.edges.filter((entry) => entry.from === id)) {
      queue.push(edge.to);
    }
  }
  return seen;
}

export function edgeKey(edge: Pick<GraphEdge, "from" | "to">): string {
  return `${edge.from}→${edge.to}`;
}

/* ── condition evaluation ───────────────────────────────────────────────── */

export type FieldValue = string | number | boolean | string[];

/**
 * One branch's result. The visit is carried because a cycle may lead back into
 * the same fan-out: without it the second pass would append to the first and
 * the join node would read fourteen results where seven ran.
 */
export type CollectedResult = { visit: number; text: string };

export type RunState = {
  input: string;
  outputs: Record<string, string>;
  /** Parsed result fields, per node id. */
  fields: Record<string, Record<string, FieldValue>>;
  /**
   * Results of nodes that ran several times in parallel over a dynamic
   * fan-out, per node id. `outputs` cannot hold these: its reducer merges by
   * key, so seven instances of one node would leave exactly one survivor.
   */
  collected: Record<string, CollectedResult[]>;
  /**
   * Why a node gave up, per node id — only for nodes set to `onError: route`,
   * which are the only ones a run survives. The empty string means "this node
   * ran and did not fail": a cycle that comes back and succeeds has to clear
   * the entry, or a `failed` edge would keep firing for the rest of the run
   * on the strength of one bad lap.
   */
  errors: Record<string, string>;
  /** The element this instance was fanned out with; `{{item}}` renders it. */
  item: string;
  visits: Record<string, number>;
  steps: number;
};

export function emptyRunState(input: string): RunState {
  return {
    input,
    outputs: {},
    fields: {},
    collected: {},
    errors: {},
    item: "",
    visits: {},
    steps: 0,
  };
}

/**
 * The text of a node, whether it ran once or n times. One place on purpose:
 * prompts, conditions and the panel must not disagree about what `{{review}}`
 * means after a fan-out.
 */
export function nodeText(state: RunState, nodeId: string): string {
  const many = state.collected[nodeId];
  if (many && many.length > 0) {
    return many
      .map((entry, index) => `── ${index + 1} of ${many.length} ──\n${entry.text}`)
      .join("\n\n");
  }
  return state.outputs[nodeId] ?? "";
}

/** A field value as it appears inside a prompt. */
export function fieldText(value: FieldValue): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export type FanOutProgress = { done: number; total: number };

/**
 * How far each dynamic fan-out has got, per target node. A fanned-out node has
 * no single status — it is n of them — and the canvas would otherwise show
 * whichever branch was written last, which reads as "the node is done" while
 * four of seven are still running.
 *
 * Derived from the run state rather than from the node_run rows because the
 * state is what the branches actually wrote: `collected` grows by one entry per
 * finished branch.
 */
export function fanOutProgress(
  graph: Graph,
  state: RunState,
): Record<string, FanOutProgress> {
  const out: Record<string, FanOutProgress> = {};
  for (const edge of graph.edges) {
    if (fanOutKey(edge) === "") continue;
    const total = resolveFanOut(graph, edge, state).items.length;
    if (total === 0) continue;
    out[edge.to] = { done: state.collected[edge.to]?.length ?? 0, total };
  }
  return out;
}

/**
 * Keep only the newest visit's branches. The reducer in the runtime delegates
 * here so that "what counts as collected" is decided in one place.
 */
export function mergeCollected(
  previous: CollectedResult[],
  next: CollectedResult[],
): CollectedResult[] {
  const all = [...previous, ...next];
  if (all.length === 0) return all;
  const newest = Math.max(...all.map((entry) => entry.visit));
  return all.filter((entry) => entry.visit === newest);
}

/** Pure and total: an unknown source reads as the empty string. */
/** `"critic.verdict"` or a bare `"verdict"` on the edge's source node. */
export function readField(
  state: RunState,
  key: string,
  sourceNodeId: string,
): FieldValue | undefined {
  const dot = key.indexOf(".");
  const nodeId = dot === -1 ? sourceNodeId : key.slice(0, dot);
  const field = dot === -1 ? key : key.slice(dot + 1);
  return state.fields[nodeId]?.[field];
}

export function evaluateCondition(
  condition: Condition,
  state: RunState,
  sourceNodeId: string,
): boolean {
  if (condition.op === "always") return true;

  const key = condition.key.trim() || sourceNodeId;
  // Outcome, not content. Both read `errors`, which only a node set to
  // `onError: route` ever writes — on a node that stops the run these two are
  // a constant, and `validateGraph` says so rather than letting the edge sit
  // there looking like a decision.
  if (condition.op === "failed") return (state.errors[key] ?? "") !== "";
  if (condition.op === "succeeded") {
    // A node that has not run yet has not succeeded either. Without the visit
    // count this would be true from the first step, and an edge meant as "once
    // the build is through" would fire before anything was built.
    return (state.visits[key] ?? 0) > 0 && (state.errors[key] ?? "") === "";
  }
  if (condition.op === "visitsBelow") {
    const limit = Number.parseInt(condition.value, 10);
    if (!Number.isFinite(limit)) return false;
    return (state.visits[key] ?? 0) < limit;
  }

  const haystack =
    condition.source === "field"
      ? String(readField(state, key, sourceNodeId) ?? "")
      : nodeText(state, key);
  const needle = condition.value;

  switch (condition.op) {
    case "contains":
      return haystack.toLowerCase().includes(needle.toLowerCase());
    case "notContains":
      return !haystack.toLowerCase().includes(needle.toLowerCase());
    case "equals":
      return haystack.trim().toLowerCase() === needle.trim().toLowerCase();
    case "matches":
      try {
        return new RegExp(needle, "i").test(haystack);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** A node either branches to all its targets, or picks exactly one. */
export function isFanOut(graph: Graph, nodeId: string): boolean {
  const out = graph.edges.filter((edge) => edge.from === nodeId);
  return out.length > 1 && out.every((edge) => edge.when === null);
}


/**
 * The sources of a structured join, or `null` when `nodeId` is not one.
 *
 * Several incoming edges do not make a join. In `harness-arc` the worker is
 * entered from the plan *and* from the critic's back edge, and those are
 * alternatives — never both in the same pass. Declaring that a join would
 * deadlock the run, because the engine would wait for a branch that never
 * delivers.
 *
 * Recognised is only the structured case, and every clause below is what makes
 * waiting safe: every incoming edge is unconditional, every branch traces back
 * through unconditional single-file steps to the *same* fan-out, that fan-out
 * has no branch that ends elsewhere, and none of it sits in a cycle. Then all
 * branches are guaranteed to run exactly once.
 */
export function joinSources(graph: Graph, nodeId: string): string[] | null {
  const incoming = graph.edges.filter((edge) => edge.to === nodeId);
  if (incoming.length < 2) return null;
  if (incoming.some((edge) => edge.when !== null || fanOutKey(edge) !== "")) {
    return null;
  }

  const roots = new Set<string>();
  for (const edge of incoming) {
    const root = branchRoot(graph, edge.from, nodeId);
    if (root === null) return null;
    roots.add(root);
  }
  if (roots.size !== 1) return null;
  const root = [...roots][0]!;

  // A fan-out branch that ends somewhere else never delivers here, and the
  // join would wait for it forever.
  if (graph.edges.filter((edge) => edge.from === root).length !== incoming.length) {
    return null;
  }

  // Inside a cycle the join could run again, and its sources no longer pass
  // through the visit check once their edges are folded into a join edge.
  // Acyclic only — the same restriction the workflow literature puts on the
  // structured synchronizing merge.
  if (reachableFrom(graph, nodeId).has(root)) return null;

  return incoming.map((edge) => edge.from);
}

/** Walk one branch back to the fan-out it started at, or `null` if it forks. */
function branchRoot(graph: Graph, from: string, join: string): string | null {
  const seen = new Set<string>([join]);
  let cur = from;
  while (!seen.has(cur)) {
    seen.add(cur);
    // A node on the branch that forks, or that is itself entered from two
    // places, breaks the "runs exactly once" guarantee this rests on.
    if (graph.edges.filter((edge) => edge.from === cur).length !== 1) return null;
    const incoming = graph.edges.filter((edge) => edge.to === cur);
    if (incoming.length !== 1) return null;
    const edge = incoming[0]!;
    if (edge.when !== null || fanOutKey(edge) !== "") return null;
    if (isFanOut(graph, edge.from)) return edge.from;
    cur = edge.from;
  }
  return null;
}

/** Every node reachable by following edges forward from `nodeId`. */
function reachableFrom(graph: Graph, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of graph.edges.filter((entry) => entry.from === id)) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return seen;
}

/** Every structured join in the graph, as target → sources. */
export function joinGroups(graph: Graph): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const sources = joinSources(graph, node.id);
    if (sources) groups.set(node.id, sources);
  }
  return groups;
}

/**
 * The fan-out key of an edge. Read through here, never directly: graphs stored
 * before this field existed have no `fanOutOver`, and they are validated and
 * drawn without being put through the schema first.
 */
export function fanOutKey(edge: GraphEdge): string {
  return (edge.fanOutOver ?? "").trim();
}

/** The dynamic fan-out leaving `nodeId`, if it has one. */
export function fanOutEdge(graph: Graph, nodeId: string): GraphEdge | null {
  return (
    graph.edges.find((edge) => edge.from === nodeId && fanOutKey(edge) !== "") ??
    null
  );
}

/**
 * The elements a dynamic fan-out will branch over, already capped. Returning
 * the surplus separately lets the runtime say what it dropped — silently
 * running 12 of 200 would look like a complete review.
 */
export function resolveFanOut(
  graph: Graph,
  edge: GraphEdge,
  state: RunState,
): { items: string[]; dropped: number } {
  const value = readField(state, fanOutKey(edge), edge.from);
  if (!Array.isArray(value)) return { items: [], dropped: 0 };
  const capped = value.slice(0, graph.maxFanOut);
  return { items: capped, dropped: value.length - capped.length };
}

export function handoffKey(edge: GraphEdge): string {
  return (edge.handoffFrom ?? "").trim();
}

/**
 * The successors a handoff edge declares, in the order they were declared.
 *
 * Only the enum form can answer this: its options are the whole list of
 * possible targets, which is what lets the canvas draw them and the
 * reachability check count them. A handoff over a plain string field returns
 * nothing here — not because it goes nowhere, but because nobody wrote down
 * where it may go, and guessing "any node" would draw sixty arrows.
 */
export function handoffTargets(graph: Graph, edge: GraphEdge): string[] {
  const key = handoffKey(edge);
  if (key === "") return [];
  const dot = key.indexOf(".");
  const ownerId = dot === -1 ? edge.from : key.slice(0, dot);
  const fieldName = dot === -1 ? key : key.slice(dot + 1);
  const field = graph.nodes
    .find((node) => node.id === ownerId)
    ?.fields.find((entry) => entry.name === fieldName);
  if (!field || field.type !== "enum") return [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  return field.options.filter((option) => ids.has(option.trim()));
}

/**
 * Every node an edge can deliver to. One answer for the drawing, the
 * reachability check and the runtime's target list — three readings of "where
 * does this edge go" that must not drift apart, because a node the canvas
 * draws and the router cannot reach is worse than either alone.
 */
export function edgeTargets(graph: Graph, edge: GraphEdge): string[] {
  return [...new Set([edge.to, ...handoffTargets(graph, edge)])];
}

/** Where a handoff edge actually went, so the log can say it. */
export type HandoffChoice = {
  /** What the field said, verbatim — the empty string when it said nothing. */
  wanted: string;
  /** The node the run goes to: the wanted one, or the edge's fallback. */
  used: string;
  /** False when the field named nothing usable and the fallback took over. */
  resolved: boolean;
};

/**
 * Where a handoff edge leads for this state.
 *
 * An unknown name is not an error that ends the run: the worker is a language
 * model, and asking it for a node id will sometimes get a label, a sentence,
 * or silence. Falling back to the declared target keeps the run going and the
 * caller says so in the log, which is the same bargain the visit-limit skip
 * makes a few lines down.
 *
 * Mostly this is the free-text form's safety net. In the enum form
 * `parseFields` has already refused anything outside the options, so an
 * off-list answer failed the node and was retried long before routing — which
 * is the better of the two failures, and the reason that form is recommended.
 * What is left there is the field being absent altogether.
 */
export function resolveHandoff(
  graph: Graph,
  edge: GraphEdge,
  state: RunState,
): HandoffChoice {
  const raw = readField(state, handoffKey(edge), edge.from);
  const wanted = raw === undefined ? "" : fieldText(raw).trim();
  const exists = graph.nodes.some((node) => node.id === wanted);
  return exists
    ? { wanted, used: wanted, resolved: true }
    : { wanted, used: edge.to, resolved: false };
}

/** An edge the router passed over because its target is out of visits. */
export type SkippedEdge = { to: string; label: string; maxVisits: number };

/**
 * Which node runs after `nodeId`. First matching edge wins, so edge order is
 * the author's priority list; an unconditional edge acts as the fallback.
 * Only meaningful for nodes that are not fan-outs.
 *
 * A matching edge is passed over when its target has used up `maxVisits`. The
 * alternative is what a back edge used to do on the last lap: route into a
 * node that can only answer by throwing, ending a run that had a finished
 * result in hand. Skipping falls through to the next edge — usually the
 * unconditional one that carries on — and the runtime says so in the log,
 * because a loop that quietly stops looping is exactly the kind of "looks
 * plausible, never fires" this graph model is built to avoid.
 */
export function resolveNext(
  graph: Graph,
  nodeId: string,
  state: RunState,
): string {
  return routeFrom(graph, nodeId, state).next;
}

export function routeFrom(
  graph: Graph,
  nodeId: string,
  state: RunState,
): { next: string; skipped: SkippedEdge[]; handoffs: HandoffChoice[] } {
  const skipped: SkippedEdge[] = [];
  for (const edge of graph.edges.filter((entry) => entry.from === nodeId)) {
    if (edge.when !== null && !evaluateCondition(edge.when, state, nodeId)) {
      continue;
    }
    // A handoff decides the target here, at routing time, which is the whole
    // point of it. Everything after this line treats it like any other target,
    // visit limit included.
    const handoff =
      handoffKey(edge) === "" ? null : resolveHandoff(graph, edge, state);
    const to = handoff ? handoff.used : edge.to;
    const target = graph.nodes.find((node) => node.id === to);
    if (target && (state.visits[to] ?? 0) >= target.maxVisits) {
      skipped.push({ to, label: target.label, maxVisits: target.maxVisits });
      continue;
    }
    return { next: to, skipped, handoffs: handoff ? [handoff] : [] };
  }
  return { next: END_NODE, skipped, handoffs: [] };
}

/**
 * Every target a node routes to. One entry for `first`, possibly several for
 * `every` — an empty array means the run ends here.
 *
 * `routeFrom` stays the single-target view because most callers, and every
 * cycle, only ever want one. This is the widening for the inclusive or.
 */
export function routeAll(
  graph: Graph,
  nodeId: string,
  state: RunState,
): { next: string[]; skipped: SkippedEdge[]; handoffs: HandoffChoice[] } {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (node?.routing !== "every") {
    const single = routeFrom(graph, nodeId, state);
    return {
      next: single.next === END_NODE ? [] : [single.next],
      skipped: single.skipped,
      handoffs: single.handoffs,
    };
  }

  const skipped: SkippedEdge[] = [];
  const handoffs: HandoffChoice[] = [];
  const next: string[] = [];
  for (const edge of graph.edges.filter((entry) => entry.from === nodeId)) {
    if (edge.when !== null && !evaluateCondition(edge.when, state, nodeId)) continue;
    const handoff =
      handoffKey(edge) === "" ? null : resolveHandoff(graph, edge, state);
    const to = handoff ? handoff.used : edge.to;
    if (to === END_NODE) continue;
    const target = graph.nodes.find((entry) => entry.id === to);
    if (target && (state.visits[to] ?? 0) >= target.maxVisits) {
      skipped.push({ to, label: target.label, maxVisits: target.maxVisits });
      continue;
    }
    if (handoff) handoffs.push(handoff);
    if (!next.includes(to)) next.push(to);
  }
  return { next, skipped, handoffs };
}

export function entryNode(graph: Graph): string {
  return graph.edges.find((edge) => edge.from === START_NODE)?.to ?? END_NODE;
}

/** The JSON contract appended to a node that declares result fields. */
export function fieldContract(fields: readonly GraphField[]): string {
  if (fields.length === 0) return "";
  const lines = fields.map((field) => {
    const type =
      field.type === "enum"
        ? `one of: ${field.options.map((o) => JSON.stringify(o)).join(" | ")}`
        : {
            string: "text",
            number: "a number",
            boolean: "true or false",
            list: 'a list of strings, e.g. ["a", "b"]',
          }[field.type];
    return `  "${field.name}": ${type}${field.description ? ` — ${field.description}` : ""}`;
  });
  return [
    "ANSWER FORMAT: end your answer with a JSON object in a ```json block.",
    "It holds exactly these keys:",
    "{",
    lines.join(",\n"),
    "}",
    "Any text may precede the block; the block itself holds JSON only.",
  ].join("\n");
}

/**
 * What a worker thread actually receives: skills first (adopt the method),
 * then the task, then the output contract (how to answer).
 */
export function composeNodePrompt(
  node: GraphNode,
  state: RunState,
  known?: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  if (node.skills.length > 0) {
    const list = node.skills.map((skill) => `\`${skill}\``).join(", ");
    parts.push(
      node.skills.length === 1
        ? `Apply the skill ${list} first and work to what it says.`
        : `Apply these skills first and work to what they say: ${list}.`,
    );
  }
  const body = renderPrompt(node.prompt, state, known);
  if (body) parts.push(body);
  const contract = fieldContract(node.fields);
  if (contract) parts.push(contract);
  return parts.join("\n\n");
}

/** Raised when a worker's answer does not satisfy the node's field contract. */
export class FieldContractError extends Error {}

/**
 * The dialogue contract. Every message the worker sends carries a control
 * block saying whether it still needs something from the user, and if so, the
 * one question it is waiting on.
 *
 * Deliberately the same shape as the field contract: routing on prose is what
 * this plugin already learned not to do, and "is this a question or a result?"
 * is exactly that kind of decision.
 */
export const DIALOG_CONTRACT = [
  "CONVERSATION FORMAT: this is a conversation, not an assignment. End EVERY",
  "one of your messages with a JSON object in a ```json block:",
  "{",
  '  "done": false,',
  '  "question": "exactly one question for me"',
  "}",
  "For as long as you need something from me, `done` is false and `question`",
  "holds exactly ONE question — not several at once. Put your recommendation in",
  "the text before it. I answer you, then you ask the next question.",
  "",
  // A real run died here, an hour and 43k tokens in: the worker quoted itself
  // inside `question` with a plain `"`, which ended the JSON string early. A
  // dialogue node cannot be retried — it uses `interrupt()`, and a retry policy
  // would read every question as a failure — so a broken block ends the run
  // rather than costing one attempt. Hence the rule, stated in the contract
  // the worker actually reads.
  "Put no straight quotation mark inside the JSON: it ends the string early and",
  "breaks the block. Quote with \u201a…\u2018 or not at all, and keep the question",
  "short — the long version belongs in the text above the block.",
  "",
  "Facts that are in the code, you look up yourself instead of asking. Only",
  "decisions are mine.",
  "",
  'Only once we agree do you answer with `{ "done": true }` and summarise the',
  "shared understanding in the text before it. That is then the result of this",
  "step.",
].join("\n");

/** What a dialogue worker receives: like an agent node, plus the turn-taking. */
export function composeDialogPrompt(
  node: GraphNode,
  state: RunState,
  known?: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  if (node.skills.length > 0) {
    const list = node.skills.map((skill) => `\`${skill}\``).join(", ");
    parts.push(
      node.skills.length === 1
        ? `Apply the skill ${list} first and work to what it says.`
        : `Apply these skills first and work to what they say: ${list}.`,
    );
  }
  const body = renderPrompt(node.prompt, state, known);
  if (body) parts.push(body);
  parts.push(DIALOG_CONTRACT);
  const contract = fieldContract(node.fields);
  if (contract) {
    parts.push(
      `When you report \`done: true\`, these keys additionally belong in the same JSON object:\n${contract}`,
    );
  }
  return parts.join("\n\n");
}

export type DialogTurn = { done: boolean; question: string };

/**
 * Read the control block out of a dialogue message. Throws on a broken
 * contract rather than guessing — guessing here means either dropping a
 * question the user should have seen, or holding the graph on a question the
 * worker never asked.
 */
export function parseDialogTurn(text: string): DialogTurn {
  const raw = extractJsonObject(text);
  if (raw === null) {
    throw new FieldContractError(
      "The message holds no JSON block with `done`.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FieldContractError("The message's JSON block is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new FieldContractError("The JSON block is not an object.");
  }
  const record = parsed as Record<string, unknown>;
  const done = record.done;
  if (typeof done !== "boolean") {
    throw new FieldContractError("`done` is missing or is not true/false.");
  }
  if (done) return { done: true, question: "" };
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (question === "") {
    throw new FieldContractError("`done` is false but `question` is missing.");
  }
  return { done: false, question };
}

/** The last fenced JSON block, else the last balanced `{…}` in the text. */
function extractJsonObject(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const body = fenced[i]![1]!.trim();
    if (body.startsWith("{")) return body;
  }
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i -= 1) {
    if (text[i] === "}") depth += 1;
    else if (text[i] === "{") {
      depth -= 1;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

/**
 * Pull the declared fields out of a worker's answer. Throws rather than
 * guessing: a malformed answer is a retryable failure, so the node's
 * `maxAttempts` gives the worker another go instead of poisoning the state.
 */
export function parseFields(
  fields: readonly GraphField[],
  text: string,
): Record<string, FieldValue> {
  if (fields.length === 0) return {};
  const raw = extractJsonObject(text);
  if (raw === null) {
    throw new FieldContractError(
      "The answer holds no JSON object with the required fields.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FieldContractError("The answer's JSON block cannot be read.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FieldContractError("The JSON block is not an object.");
  }

  const source = parsed as Record<string, unknown>;
  const out: Record<string, FieldValue> = {};
  for (const field of fields) {
    const value = source[field.name];
    if (value === undefined || value === null) {
      throw new FieldContractError(`Field "${field.name}" is missing from the answer.`);
    }
    switch (field.type) {
      case "number": {
        const numeric = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numeric)) {
          throw new FieldContractError(`Field "${field.name}" is not a number.`);
        }
        out[field.name] = numeric;
        break;
      }
      case "boolean": {
        if (typeof value === "boolean") out[field.name] = value;
        else if (value === "true" || value === "false") {
          out[field.name] = value === "true";
        } else {
          throw new FieldContractError(
            `Field "${field.name}" is not a boolean.`,
          );
        }
        break;
      }
      case "list": {
        // An empty list is a legitimate answer ("nothing changed"), so it is
        // not a contract breach — the fan-out simply has nothing to do.
        if (!Array.isArray(value)) {
          throw new FieldContractError(`Field "${field.name}" is not a list.`);
        }
        const items = value
          .map((entry) => String(entry).trim())
          .filter((entry) => entry !== "");
        out[field.name] = items;
        break;
      }
      case "enum": {
        const text = String(value).trim();
        const match = field.options.find(
          (option) => option.toLowerCase() === text.toLowerCase(),
        );
        if (match === undefined) {
          throw new FieldContractError(
            `Field "${field.name}" is "${text}"; allowed are: ${field.options.join(", ")}.`,
          );
        }
        out[field.name] = match;
        break;
      }
      default:
        out[field.name] = String(value);
    }
  }
  return out;
}

/**
 * `{{input}}`, `{{item}}`, `{{node_id}}` and `{{node_id.field}}` — everything
 * else is left alone.
 *
 * A field placeholder renders as the empty string while the node it names has
 * not run yet. That case is normal rather than broken: a node on a back edge
 * reads a field the node ahead of it only writes on the second pass, and the
 * first pass must not ship literal braces to the worker.
 *
 * `known` extends that to the whole-node placeholder. Without it `{{version}}`
 * on the first pass reached the worker as those six characters, under a line
 * saying "empty = first wave" — and in `concept-waves` two lines above a rule
 * forbidding placeholders in the answer. The name still has to be *known* for
 * that: a typo names no node, stays standing, and is what the validator's
 * error about dead wiring is built on (`renderPrompt` and the validator share
 * `PLACEHOLDER` for exactly this reason). Callers without a graph at hand pass
 * nothing and keep the old behaviour.
 */
export function renderPrompt(
  template: string,
  state: RunState,
  known?: ReadonlySet<string>,
): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (name === "input") return state.input;
    if (name === "item") return state.item;
    const dot = name.indexOf(".");
    if (dot !== -1) {
      const owner = name.slice(0, dot);
      const suffix = name.slice(dot + 1);
      const value = state.fields[owner]?.[suffix];
      if (value !== undefined) return fieldText(value);
      // `{{build.error}}` — why the node gave up, so the fallback node can be
      // told what it is standing in for instead of guessing. A declared field
      // of that name wins, because the author wrote that one down on purpose.
      if (suffix === "error") return state.errors[owner] ?? "";
      return "";
    }
    if (state.collected[name] !== undefined) return nodeText(state, name);
    const output = state.outputs[name];
    if (output !== undefined) return output;
    return known?.has(name) ? "" : whole;
  });
}
