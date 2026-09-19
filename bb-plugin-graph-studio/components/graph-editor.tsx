// Form-based graph editor with a live preview.
//
// Deliberately not a drag-and-drop canvas: the layout is computed, so the only
// thing worth editing is the structure. Every change re-lays out and re-checks
// immediately, which is what makes a cyclic graph safe to author by hand.
import { useMemo, useState } from "react";
import {
  // Aliased because JSX reads a lowercase tag as an intrinsic element.
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders,
} from "@get-bb/plugin-sdk/app";
import {
  CONDITION_OPS,
  END_NODE,
  FIELD_TYPES,
  NODE_KINDS,
  ROUTING_MODES,
  START_NODE,
  conditionSchema,
  edgeSchema,
  fieldSchema,
  graphSchema,
  nodeExecution,
  nodeSchema,
  spawnsThread,
  validateGraph,
  type Condition,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "../lib/graph";
import { runCommand } from "../lib/describe";
import { groupedLibrary } from "../lib/templates";
import { GraphCanvas, CanvasLegend } from "./graph-canvas";
import { CopyCommand } from "./copy-command";
import { ExportedFileView, type ExportedFile } from "./exported-file";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<(typeof NODE_KINDS)[number], string> = {
  agent: "Agent (own thread)",
  dialog: "Dialogue (asks you, waits for an answer)",
  human: "Approval (waits for you)",
  note: "Note (does nothing)",
  subgraph: "Subgraph (embeds another graph)",
};

/**
 * Spelled out rather than "first"/"every", because the short form reads as a
 * count and this is a choice between two behaviours. The node's own outgoing
 * edges look identical either way — that is exactly why the setting cannot
 * hide in the collapsed "Execution" section.
 */
const ROUTING_LABELS: Record<(typeof ROUTING_MODES)[number], string> = {
  first: "the first matching edge",
  every: "every matching edge",
};

const FIELD_TYPE_LABELS: Record<(typeof FIELD_TYPES)[number], string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes/No",
  enum: "Choice",
  list: "List (can fan out)",
};

/**
 * The schema's own defaults, so the "what deviates from normal" summary below
 * cannot drift from what a fresh node actually is.
 */
const NODE_DEFAULTS = nodeSchema.parse({ id: "n", label: "n" });

/**
 * What the collapsed execution section has to admit to. A setting that is
 * folded away is a setting nobody sees — and an unseen model choice is exactly
 * the kind of silently-active state this project keeps getting bitten by. So
 * the summary names every deviation from the defaults, and says "Standard"
 * only when there is genuinely nothing to know.
 */
function executionSummary(node: GraphNode): string {
  const parts: string[] = [];
  const execution = nodeExecution(node);
  if (execution) {
    parts.push(execution.model);
    if (execution.reasoningLevel) parts.push(`Reasoning ${execution.reasoningLevel}`);
  } else if (node.providerId || node.model) {
    // Half a selection: validation reports it as an error, and the summary
    // must not pretend the node is configured.
    parts.push("incomplete model choice");
  }
  if (node.maxVisits !== NODE_DEFAULTS.maxVisits) {
    parts.push(`max. ${node.maxVisits} visits`);
  }
  if (node.maxAttempts !== NODE_DEFAULTS.maxAttempts) {
    parts.push(`${node.maxAttempts} attempts`);
  }
  if (node.kind === "dialog" && node.maxTurns !== NODE_DEFAULTS.maxTurns) {
    parts.push(`${node.maxTurns} questions`);
  }
  if (node.onError !== NODE_DEFAULTS.onError) {
    parts.push("routes its failure");
  }
  return parts.length === 0 ? "Default" : parts.join(" · ");
}

const OP_LABEL: Record<(typeof CONDITION_OPS)[number], string> = {
  always: "always (fallback)",
  contains: "result contains",
  notContains: "result does not contain",
  equals: "result is exactly",
  matches: "result matches regex",
  visitsBelow: "node ran fewer than N times",
  failed: "node failed",
  succeeded: "node succeeded",
};

/** The two conditions that ask about an outcome instead of reading text. */
function isOutcomeOp(op: Condition["op"]): boolean {
  return op === "failed" || op === "succeeded";
}

/**
 * A new node, with every field the schema declares. Built through the schema
 * rather than written out by hand: the three literals this replaced each had
 * to be remembered whenever a field was added, and the one that was forgotten
 * would only show up as a type error — or, worse, not at all.
 */
function newNode(id: string, label: string, prompt = ""): GraphNode {
  return nodeSchema.parse({ id, label, prompt });
}

/** An edge, for the same reason `newNode` exists: the schema owns the fields. */
function newEdge(from: string, to: string): GraphEdge {
  return edgeSchema.parse({ from, to });
}

/**
 * A blank draft is deliberately NOT parsed: an empty id and name are exactly
 * what the user is about to fill in, but they fail the schema, so parsing here
 * threw a ZodError during the editor's first render. The draft is held as a
 * plain value and validated continuously instead; `onSave` is the one place
 * that parses, and it is gated on that validation passing.
 */
function emptyGraph(): Graph {
  return {
    id: "",
    name: "",
    description: "",
    example: "",
    nodes: [newNode("step1", "First step", "Work on:\n\n{{input}}")],
    edges: [newEdge(START_NODE, "step1"), newEdge("step1", END_NODE)],
    maxSteps: 60,
    maxFanOut: 12,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * How a node runs, as opposed to what it does: guards, retries, and the
 * optional provider/model.
 *
 * Folded away on purpose. Everything in here has a working default, while the
 * things above it — kind, prompt, skills, declared fields — are what authoring
 * a graph actually consists of. The same split is what the next two roadmap
 * items need: a code node adds to the content half, a free state schema is a
 * graph-level concern, and neither has to squeeze past the tuning knobs.
 *
 * The summary is not decoration. A collapsed section hides state, and hidden
 * state that silently takes effect is this project's recurring bug — so the
 * fold has to say what deviates before anyone opens it.
 */
function NodeExecutionSection({
  node,
  index,
  onPatch,
}: {
  node: GraphNode;
  index: number;
  onPatch: (patch: Partial<GraphNode>) => void;
}) {
  const providers = experimental_useProviders();
  const execution = nodeExecution(node);
  const explicit = node.providerId !== null || node.model !== null;

  return (
    <details className="rounded-md border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
        <Icon name="Settings" className="size-3.5" />
        Execution
        <span className="text-foreground">{executionSummary(node)}</span>
      </summary>
      <div className="space-y-2 border-t border-border px-2 py-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              At most N visits
            </span>
            <Input
              type="number"
              min={1}
              max={50}
              value={node.maxVisits}
              onChange={(event) =>
                onPatch({
                  maxVisits: Number.parseInt(event.target.value, 10) || 1,
                })
              }
              aria-label={`Visit limit of node ${index + 1}`}
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-muted-foreground">
              Attempts per visit
            </span>
            <Input
              type="number"
              min={1}
              max={5}
              value={node.maxAttempts}
              onChange={(event) =>
                onPatch({
                  maxAttempts: Number.parseInt(event.target.value, 10) || 1,
                })
              }
              aria-label={`Attempts of node ${index + 1}`}
            />
          </label>
          {node.kind === "dialog" ? (
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">
                Questions before wrapping up
              </span>
              <Input
                type="number"
                min={1}
                max={50}
                value={node.maxTurns}
                onChange={(event) =>
                  onPatch({
                    maxTurns: Number.parseInt(event.target.value, 10) || 1,
                  })
                }
                aria-label={`Questions of node ${index + 1}`}
              />
            </label>
          ) : null}
        </div>

        {node.kind === "agent" || node.kind === "dialog" ? (
          <label className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">
              When the attempts are used up
            </span>
            <select
              value={node.onError}
              onChange={(event) =>
                onPatch({ onError: event.target.value as GraphNode["onError"] })
              }
              aria-label={`Failure handling of node ${index + 1}`}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="stop">End the run</option>
              <option value="route">
                Carry on — an edge decides, using "failed"
              </option>
            </select>
          </label>
        ) : null}

        {spawnsThread(node) ? (
          <div className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">
              Model — with no choice of its own, the worker runs on the model
              of the thread the run belongs to.
            </span>
            <select
              value={explicit ? "explicit" : "inherit"}
              onChange={(event) => {
                if (event.target.value === "inherit") {
                  onPatch({
                    providerId: null,
                    model: null,
                    reasoningLevel: null,
                    serviceTier: null,
                  });
                  return;
                }
                // Seeding only the provider leaves the node incomplete, and
                // validation says so in as many words. That is better than
                // inventing a model id the catalog may not have: a wrong one
                // would be found only when a worker fails to start.
                onPatch({
                  providerId: providers.providers[0]?.id ?? "",
                  model: "",
                });
              }}
              aria-label={`Model choice of node ${index + 1}`}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="inherit">Inherit from the parent thread</option>
              <option value="explicit">Set for this node</option>
            </select>
            {explicit ? (
              <ProviderModelPicker
                value={{
                  providerId: node.providerId ?? "",
                  model: node.model ?? "",
                  reasoningLevel: node.reasoningLevel ?? "medium",
                  ...(node.serviceTier ? { serviceTier: node.serviceTier } : {}),
                }}
                onChange={(value) =>
                  onPatch({
                    providerId: value.providerId,
                    model: value.model,
                    reasoningLevel: value.reasoningLevel,
                    serviceTier: value.serviceTier ?? null,
                  })
                }
              />
            ) : null}
            {explicit && !execution ? (
              <p className="text-[11px] text-destructive">
                Provider and model belong together — set halfway, the choice
                is discarded and the node would run on the inherited model.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** "nodes.2.id" → "Node 3 · Id", so an issue points at a visible field. */
function fieldLabel(path: ReadonlyArray<PropertyKey>): string {
  const [head, index, field] = path;
  if (head === "nodes") return `Node ${Number(index) + 1} · ${String(field ?? "")}`;
  if (head === "edges") return `Edge ${Number(index) + 1} · ${String(field ?? "")}`;
  if (head === "id") return "Id";
  if (head === "name") return "Name";
  return path.map(String).join(".") || "Graph";
}

function issueText(path: ReadonlyArray<PropertyKey>, message: string): string {
  const field = path[path.length - 1];
  if (field === "id") {
    return "Lowercase letter first, then lowercase letters, digits or hyphens.";
  }
  if (field === "name") return "must not be empty.";
  return message;
}

export type AvailableSkill = {
  id: string;
  name: string;
  description: string | null;
  scope: string;
};

export function GraphEditor({
  graphs,
  templates,
  graphId,
  pending,
  availableSkills = [],
  skillsError = null,
  onSave,
  onCancel,
  onClone,
  onDelete,
  onExport,
  onImport,
  exported = null,
  exporting = false,
  onDismissExport,
}: {
  graphs: Graph[];
  templates: Graph[];
  graphId: string | null;
  pending: boolean;
  availableSkills?: AvailableSkill[];
  skillsError?: string | null;
  onSave: (graph: Graph) => void;
  onCancel: () => void;
  onClone: (templateId: string, id: string, name: string) => void;
  onDelete: (id: string) => void;
  onExport?: (id: string) => void;
  onImport?: (json: string) => void;
  exported?: ExportedFile | null;
  exporting?: boolean;
  onDismissExport?: () => void;
}) {
  const existing = graphId ? graphs.find((entry) => entry.id === graphId) : null;
  const [draft, setDraft] = useState<Graph>(existing ?? emptyGraph());
  const [cloneFrom, setCloneFrom] = useState(templates[0]?.id ?? "");
  const [cloneId, setCloneId] = useState("");
  const [importText, setImportText] = useState("");

  /**
   * Subgraph nodes are validated against the library the editor already holds,
   * so an id that names nothing is an error while typing rather than at the
   * first run. Templates count too — they are graphs like any other.
   */
  const resolveGraph = useMemo(() => {
    const library = new Map(
      [...templates, ...graphs].map((entry) => [entry.id, entry]),
    );
    return (id: string) => library.get(id) ?? null;
  }, [graphs, templates]);

  const problems = useMemo(() => {
    const parsed = graphSchema.safeParse(draft);
    if (parsed.success) return validateGraph(parsed.data, resolveGraph);
    // Zod's own wording ("Too small…") is unhelpful next to a form field, so
    // each issue is reported with the field it belongs to.
    return parsed.error.issues.map((issue) => ({
      level: "error" as const,
      message: `${fieldLabel(issue.path)}: ${issueText(issue.path, issue.message)}`,
    }));
  }, [draft, resolveGraph]);

  const blocking = problems.filter((problem) => problem.level === "error");
  const nodeIds = draft.nodes.map((node) => node.id);
  /** Every declared field as `nodeId.fieldName`, for the condition picker. */
  const declaredFields = draft.nodes.flatMap((node) =>
    node.fields.map((field) => ({
      key: `${node.id}.${field.name}`,
      type: field.type,
    })),
  );
  /** Only a list field can be fanned out over. */
  const listFields = declaredFields.filter((entry) => entry.type === "list");
  /**
   * A handoff target comes from a choice or a text. The choice is listed first
   * and labelled as the recommended one, because it is the form that keeps the
   * canvas able to draw and the validator able to check.
   */
  const handoffFields = declaredFields.filter(
    (entry) => entry.type === "enum" || entry.type === "string",
  );
  const targets = [...nodeIds, END_NODE];
  const sources = [START_NODE, ...nodeIds];

  const patchNode = (index: number, patch: Partial<GraphNode>) =>
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node, i) =>
        i === index ? { ...node, ...patch } : node,
      ),
    }));

  const patchEdge = (index: number, patch: Partial<GraphEdge>) =>
    setDraft((current) => ({
      ...current,
      edges: current.edges.map((edge, i) =>
        i === index ? { ...edge, ...patch } : edge,
      ),
    }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" className="-ml-2 h-6 px-2" onClick={onCancel}>
          <Icon name="ChevronLeft" className="size-4" />
          Overview
        </Button>
        <div className="flex gap-2">
          {existing ? (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => onDelete(existing.id)}
            >
              Delete
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={pending || blocking.length > 0 || draft.id === ""}
            onClick={() => onSave(graphSchema.parse(draft))}
          >
            Save
          </Button>
        </div>
      </div>

      {!existing ? (
        <div className="rounded-lg border border-border bg-card px-3 py-3">
          <p className="text-sm font-medium">Start from a template</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Quicker than starting from nothing. The <em>Patterns</em> headings
            run from the simplest control flow to the most composed — one step,
            one branch, several at once, cycles; under <em>Work</em> the arcs
            for this repo.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <select
              value={cloneFrom}
              onChange={(event) => setCloneFrom(event.target.value)}
              className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
            >
              {groupedLibrary(templates, "section").map((section) => (
                <optgroup key={section.key} label={section.label}>
                  {section.graphs.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Input
              value={cloneId}
              onChange={(event) => setCloneId(event.target.value)}
              placeholder="new-id"
              aria-label="Id of the new graph"
              className="h-8 flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || cloneId.trim() === ""}
              onClick={() => {
                const template = templates.find((entry) => entry.id === cloneFrom);
                onClone(cloneFrom, cloneId.trim(), template?.name ?? cloneId);
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Id (fixed)</span>
          <Input
            value={draft.id}
            disabled={Boolean(existing)}
            onChange={(event) =>
              setDraft({ ...draft, id: event.target.value.toLowerCase() })
            }
            placeholder="my-graph"
            aria-label="Graph id"
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Name</span>
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            aria-label="Graph name"
          />
        </label>
      </div>

      {/*
        The name says what the graph is, the example says what you put into it
        — and only the second one tells a reader six weeks later whether this
        is the graph for the task in front of them. It is also what the
        ready-made command line below offers.
      */}
      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">
          Example task — what is this graph for?
        </span>
        <Input
          value={draft.example}
          onChange={(event) => setDraft({ ...draft, example: event.target.value })}
          placeholder="Move the product filter's sorting to the server side"
          aria-label="Example task"
        />
        <CopyCommand command={runCommand(draft)} />
      </label>

      {/*
        Caption and legend share one row. They used to take a line each, above
        and below the canvas — three rows of chrome around the one thing worth
        looking at, in a panel where vertical space is the scarce resource.
        The legend keeps its meaning next to the caption; it explains the
        drawing either way.
      */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Preview
          </p>
          <CanvasLegend />
        </div>
        <GraphCanvas graph={draft} className="max-h-[55vh]" />
      </div>

      {problems.length > 0 ? (
        <ul className="space-y-1">
          {problems.map((problem) => (
            <li
              key={problem.message}
              className={cn(
                "flex items-start gap-1.5 text-xs",
                problem.level === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              <Icon
                name={problem.level === "error" ? "AlertTriangle" : "Info"}
                className="mt-px size-3.5 shrink-0"
              />
              {problem.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name="Check" className="size-3.5" />
          The graph is runnable.
        </p>
      )}

      {/* nodes */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Nodes
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2"
            onClick={() =>
              setDraft({
                ...draft,
                nodes: [
                  ...draft.nodes,
                  newNode(
                    `step${draft.nodes.length + 1}`,
                    `Step ${draft.nodes.length + 1}`,
                  ),
                ],
              })
            }
          >
            <Icon name="Plus" className="size-3.5" />
            Node
          </Button>
        </div>
        {draft.nodes.map((node, index) => (
          <details key={index} className="rounded-lg border border-border bg-card">
            <summary className="cursor-pointer list-none px-3 py-2 text-sm">
              {node.label}{" "}
              <span className="text-muted-foreground">({node.id})</span>
              {nodeExecution(node) ? (
                <span className="ml-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {nodeExecution(node)?.model}
                </span>
              ) : null}
            </summary>
            <div className="space-y-2 border-t border-border px-3 py-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">Id</span>
                  <Input
                    value={node.id}
                    onChange={(event) =>
                      patchNode(index, { id: event.target.value.toLowerCase() })
                    }
                    aria-label={`Id of node ${index + 1}`}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">Label</span>
                  <Input
                    value={node.label}
                    onChange={(event) => patchNode(index, { label: event.target.value })}
                    aria-label={`Label of node ${index + 1}`}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">Kind</span>
                  <select
                    value={node.kind}
                    onChange={(event) =>
                      patchNode(index, { kind: event.target.value as GraphNode["kind"] })
                    }
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                  >
                    {NODE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                {/* Only where there is something to choose between. On a node
                    with one way out the setting changes nothing, and an inert
                    dropdown on every node teaches that it does not matter. */}
                {draft.edges.filter((edge) => edge.from === node.id).length > 1 ? (
                  <label className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Takes</span>
                    <select
                      value={node.routing}
                      onChange={(event) =>
                        patchNode(index, {
                          routing: event.target.value as GraphNode["routing"],
                        })
                      }
                      aria-label={`Routing of node ${index + 1}`}
                      className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                    >
                      {ROUTING_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {ROUTING_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              {draft.edges.filter((edge) => edge.from === node.id).length > 1 &&
              node.routing === "every" ? (
                <p className="text-[11px] text-muted-foreground">
                  Every edge whose condition holds is taken, and those branches
                  run at once. They cannot be merged again afterwards: a branch
                  that was not taken never arrives, so a node waiting for it
                  would wait forever.
                </p>
              ) : null}
              <label
                className={cn(
                  "block space-y-1",
                  // A subgraph node hands no prompt to anybody; showing the
                  // field would invite writing an instruction that reaches
                  // nobody.
                  node.kind === "subgraph" && "hidden",
                )}
              >
                <span className="text-[11px] text-muted-foreground">
                  Prompt — {"{{input}}"} and {"{{node_id}}"} are filled in
                </span>
                <textarea
                  value={node.prompt}
                  onChange={(event) => patchNode(index, { prompt: event.target.value })}
                  rows={4}
                  className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs"
                  aria-label={`Prompt of node ${index + 1}`}
                />
              </label>
              {node.kind === "subgraph" ? (
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    Embedded graph — its nodes run as part of this run and
                    share the state. A later node reads their results as{" "}
                    {"{{node_id}}"}.
                  </span>
                  <select
                    value={node.graphId}
                    onChange={(event) =>
                      patchNode(index, { graphId: event.target.value })
                    }
                    aria-label={`Embedded graph of node ${index + 1}`}
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                  >
                    <option value="">Choose a graph …</option>
                    {groupedLibrary(
                      // The graph cannot embed itself, so it is not offered.
                      [...templates, ...graphs].filter(
                        (entry) => entry.id !== draft.id,
                      ),
                    ).map((section) => (
                      <optgroup key={section.key} label={section.label}>
                        {section.graphs.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name} ({entry.nodes.length} nodes)
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              ) : null}
              {node.kind === "agent" || node.kind === "dialog" ? (
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">
                    Skills — reviewed ways of working, instead of writing the
                    rules out yourself. The worker loads them itself.
                  </span>
                  {node.skills.length > 0 ? (
                    <ul className="flex flex-wrap gap-1">
                      {node.skills.map((skill) => (
                        <li key={skill}>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
                            onClick={() =>
                              patchNode(index, {
                                skills: node.skills.filter((s) => s !== skill),
                              })
                            }
                            aria-label={`Remove skill ${skill}`}
                          >
                            {skill}
                            <Icon name="X" className="size-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {availableSkills.length > 0 ? (
                    <select
                      value=""
                      onChange={(event) => {
                        const id = event.target.value;
                        if (!id || node.skills.includes(id)) return;
                        patchNode(index, { skills: [...node.skills, id] });
                      }}
                      aria-label={`Add a skill to node ${index + 1}`}
                      className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                    >
                      <option value="">Add a skill …</option>
                      {availableSkills
                        .filter((skill) => !node.skills.includes(skill.id))
                        .map((skill) => (
                          <option key={skill.id} value={skill.id}>
                            {skill.name} ({skill.scope})
                          </option>
                        ))}
                    </select>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {skillsError
                        ? `Skills unavailable: ${skillsError}`
                        : "No skills found."}
                    </p>
                  )}
                </div>
              ) : null}
              {node.kind === "agent" ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      Result fields — the worker additionally answers as JSON.
                      Edges then compare values instead of searching text.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 shrink-0 px-2"
                      onClick={() =>
                        patchNode(index, {
                          fields: [
                            ...node.fields,
                            fieldSchema.parse({
                              name: `field${node.fields.length + 1}`,
                            }),
                          ],
                        })
                      }
                    >
                      <Icon name="Plus" className="size-3.5" />
                      Field
                    </Button>
                  </div>
                  {node.fields.map((declared, fieldIndex) => {
                    const patchField = (patch: Partial<typeof declared>) =>
                      patchNode(index, {
                        fields: node.fields.map((entry, i) =>
                          i === fieldIndex ? { ...entry, ...patch } : entry,
                        ),
                      });
                    return (
                      <div
                        key={fieldIndex}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5"
                      >
                        <Input
                          value={declared.name}
                          onChange={(event) =>
                            patchField({ name: event.target.value.toLowerCase() })
                          }
                          aria-label={`Name of field ${fieldIndex + 1} in node ${index + 1}`}
                          className="h-7 w-32"
                        />
                        <select
                          value={declared.type}
                          onChange={(event) =>
                            patchField({
                              type: event.target
                                .value as (typeof FIELD_TYPES)[number],
                            })
                          }
                          aria-label={`Type of field ${fieldIndex + 1} in node ${index + 1}`}
                          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
                        >
                          {FIELD_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {FIELD_TYPE_LABELS[type]}
                            </option>
                          ))}
                        </select>
                        {declared.type === "enum" ? (
                          <Input
                            value={declared.options.join(", ")}
                            onChange={(event) =>
                              patchField({
                                options: event.target.value
                                  .split(",")
                                  .map((option) => option.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="APPROVE, REWORK, BLOCK"
                            aria-label={`Choices of field ${fieldIndex + 1} in node ${index + 1}`}
                            className="h-7 flex-1"
                          />
                        ) : (
                          <Input
                            value={declared.description}
                            onChange={(event) =>
                              patchField({ description: event.target.value })
                            }
                            placeholder="Description (optional)"
                            aria-label={`Description of field ${fieldIndex + 1} in node ${index + 1}`}
                            className="h-7 flex-1"
                          />
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-destructive"
                          onClick={() =>
                            patchNode(index, {
                              fields: node.fields.filter(
                                (_, i) => i !== fieldIndex,
                              ),
                            })
                          }
                          aria-label={`Remove field ${fieldIndex + 1} in node ${index + 1}`}
                        >
                          <Icon name="Trash2" className="size-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <NodeExecutionSection
                node={node}
                index={index}
                onPatch={(patch) => patchNode(index, patch)}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-destructive"
                onClick={() =>
                  setDraft({
                    ...draft,
                    nodes: draft.nodes.filter((_, i) => i !== index),
                    edges: draft.edges.filter(
                      (edge) => edge.from !== node.id && edge.to !== node.id,
                    ),
                  })
                }
              >
                Remove node
              </Button>
            </div>
          </details>
        ))}
      </div>

      {/* edges */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Edges
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2"
            onClick={() =>
              setDraft({
                ...draft,
                edges: [...draft.edges, newEdge(nodeIds[0] ?? START_NODE, END_NODE)],
              })
            }
          >
            <Icon name="Plus" className="size-3.5" />
            Edge
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Several unconditional edges from one node run in parallel. With
          conditions, the first matching one wins — an unconditional edge at the
          bottom serves as the fallback. An edge back upwards makes a cycle.
          Compare a result field rather than raw text where you can: prose
          contains the words you are looking for all too casually.
        </p>
        {draft.edges.map((edge, index) => (
          <div
            key={index}
            className="space-y-2 rounded-lg border border-border bg-card px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={edge.from}
                onChange={(event) => patchEdge(index, { from: event.target.value })}
                aria-label={`Source of edge ${index + 1}`}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                {sources.map((id) => (
                  <option key={id} value={id}>
                    {id === START_NODE ? "Start" : id}
                  </option>
                ))}
              </select>
              <Icon name="ChevronRight" className="size-4 text-muted-foreground" />
              <select
                value={edge.to}
                onChange={(event) => patchEdge(index, { to: event.target.value })}
                aria-label={`Target of edge ${index + 1}`}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                {targets.map((id) => (
                  <option key={id} value={id}>
                    {id === END_NODE ? "End" : id}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-destructive"
                onClick={() =>
                  setDraft({
                    ...draft,
                    edges: draft.edges.filter((_, i) => i !== index),
                  })
                }
                aria-label={`Remove edge ${index + 1}`}
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={edge.when ? edge.when.op : "__none__"}
                onChange={(event) => {
                  const value = event.target.value;
                  patchEdge(index, {
                    when:
                      value === "__none__"
                        ? null
                        : conditionSchema.parse({
                            ...(edge.when ?? {}),
                            op: value as Condition["op"],
                          }),
                  });
                }}
                aria-label={`Condition of edge ${index + 1}`}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              >
                <option value="__none__">no condition</option>
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABEL[op]}
                  </option>
                ))}
              </select>
              {edge.when && isOutcomeOp(edge.when.op) ? (
                // An outcome condition names a node, not a field and not a
                // search text — so it gets its own picker rather than the
                // text-and-field one below, which would offer both.
                <select
                  value={edge.when.key}
                  onChange={(event) =>
                    patchEdge(index, {
                      when: {
                        ...edge.when!,
                        source: "output",
                        key: event.target.value,
                        value: "",
                      },
                    })
                  }
                  aria-label={`Subject of edge ${index + 1}`}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                >
                  <option value="">This edge's source node</option>
                  {nodeIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : null}
              {edge.when && edge.when.op !== "always" && !isOutcomeOp(edge.when.op) ? (
                <>
                  <select
                    value={
                      edge.when.source === "field"
                        ? `field:${edge.when.key}`
                        : `output:${edge.when.key}`
                    }
                    onChange={(event) => {
                      const [source, ...rest] = event.target.value.split(":");
                      patchEdge(index, {
                        when: {
                          ...edge.when!,
                          source: source === "field" ? "field" : "output",
                          key: rest.join(":"),
                        },
                      });
                    }}
                    aria-label={`Subject of edge ${index + 1}`}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                  >
                    <option value="output:">Text of this edge's source node</option>
                    {/* Declared fields first: comparing a value beats
                        searching prose, which is what broke a live run once. */}
                    {declaredFields.length > 0 ? (
                      <optgroup label="Fields (recommended)">
                        {declaredFields.map((entry) => (
                          <option key={entry.key} value={`field:${entry.key}`}>
                            {entry.key} ({FIELD_TYPE_LABELS[entry.type]})
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="Raw text">
                      {nodeIds.map((id) => (
                        <option key={id} value={`output:${id}`}>
                          Text of {id}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <Input
                    value={edge.when.value}
                    onChange={(event) =>
                      patchEdge(index, {
                        when: { ...edge.when!, value: event.target.value },
                      })
                    }
                    placeholder={
                      edge.when.op === "visitsBelow" ? "Count" : "Search text"
                    }
                    aria-label={`Comparison value of edge ${index + 1}`}
                    className="h-8 flex-1"
                  />
                </>
              ) : null}
            </div>
            {/* Only offered once a list field exists: a fan-out needs
                something to fan out over, and an empty dropdown on every edge
                is noise on the graphs that will never use one. */}
            {listFields.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-muted-foreground">
                  Fan out over
                </label>
                <select
                  value={edge.fanOutOver || "__none__"}
                  onChange={(event) => {
                    const value = event.target.value;
                    patchEdge(index, {
                      fanOutOver: value === "__none__" ? "" : value,
                      // A fan-out edge carries no condition — the runtime
                      // branches over every element, so there is nothing left
                      // for a condition to decide.
                      ...(value === "__none__" ? {} : { when: null }),
                    });
                  }}
                  aria-label={`Fan-out of edge ${index + 1}`}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                >
                  <option value="__none__">no fan-out</option>
                  {listFields.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.key}
                    </option>
                  ))}
                </select>
                {edge.fanOutOver ? (
                  <span className="text-[11px] text-muted-foreground">
                    The target runs once per entry and reads it as{" "}
                    <code>{"{{item}}"}</code>; at most {draft.maxFanOut}.
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* Same rule as the fan-out above: offered only once there is a
                field it could read, so it stays out of the way on the graphs
                that route the ordinary way. */}
            {handoffFields.length > 0 && !edge.fanOutOver ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[11px] text-muted-foreground">
                  Target from a field
                </label>
                <select
                  value={edge.handoffFrom || "__none__"}
                  onChange={(event) => {
                    const value = event.target.value;
                    patchEdge(index, {
                      handoffFrom: value === "__none__" ? "" : value,
                    });
                  }}
                  aria-label={`Handoff of edge ${index + 1}`}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                >
                  <option value="__none__">no, the target above</option>
                  <optgroup label="Choice (recommended)">
                    {handoffFields
                      .filter((entry) => entry.type === "enum")
                      .map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.key}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Free text (open swarm)">
                    {handoffFields
                      .filter((entry) => entry.type === "string")
                      .map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.key}
                        </option>
                      ))}
                  </optgroup>
                </select>
                {edge.handoffFrom ? (
                  <span className="text-[11px] text-muted-foreground">
                    The worker picks the next node. The target above becomes the
                    fallback for when it names nothing known.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/*
        Moved to the bottom: exporting a graph is a utility somebody reaches
        for now and then, and it used to sit between the header and the form —
        a collapsed row of chrome pushing the preview further down every time
        the editor opened.
      */}
      <details className="rounded-lg border border-border bg-card">
        <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium">
          File: export / import
        </summary>
        <div className="space-y-2 border-t border-border px-3 py-3">
          <p className="text-[11px] text-muted-foreground">
            Graphs live centrally in the plugin database. As a JSON file they
            can be put into the repo, versioned and shared. On the command
            line:
          </p>
          <CopyCommand
            command={`bb graph-studio export ${draft.id || "<graph-id>"} > file.json`}
          />
          <CopyCommand command="bb graph-studio import file.json" />
          {existing && onExport ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={exporting}
                onClick={() => onExport(existing.id)}
              >
                {exporting ? "Exporting …" : "Show as JSON"}
              </Button>
              <ExportedFileView
                exported={exported}
                onDismiss={onDismissExport ?? (() => {})}
              />
            </>
          ) : null}
          {onImport ? (
            <div className="space-y-1">
              <label
                className="block text-[11px] text-muted-foreground"
                htmlFor="gs-import"
              >
                Paste JSON and import
              </label>
              <textarea
                id="gs-import"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                rows={4}
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
          ) : null}
        </div>
      </details>
    </div>
  );
}
