/**
 * How a graph reads as text.
 *
 * There are two audiences with the same need: a person typing
 * `bb graph-studio show`, and a model that was handed a thread and has to
 * answer "what does this graph do?". Both get the same rendering on purpose —
 * a second, prettier description for one of them would drift, and then the
 * answer depends on who asked.
 *
 * Deliberately not `export`: that is what the JSON export is for. This is the
 * short form — the shape of the graph, not every default value.
 */
import { groupedLibrary, templatePattern } from "./templates";
import { elapsedLabel } from "./activity";
import {
  fanOutKey,
  handoffKey,
  nodeExecution,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphProblem,
} from "./graph";

/**
 * What a node run cost, as one short phrase. Shared by the CLI and the panel
 * on purpose — two renderings of the same number drift, and then "what did
 * that run cost" depends on where you looked.
 *
 * Null is not zero. A node whose usage could not be read says nothing at all
 * rather than claiming it was free.
 */
export function describeCost(run: {
  startedAt: number | null;
  endedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): string {
  const parts: string[] = [];
  if (run.startedAt !== null && run.endedAt !== null) {
    const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
    parts.push(
      seconds < 60
        ? `${seconds} s`
        : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`,
    );
  }
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  if (run.inputTokens !== null || run.outputTokens !== null) {
    parts.push(
      tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`,
    );
  }
  return parts.join(" · ");
}

/**
 * One attempt as a line of `bb graph-studio status`.
 *
 * A running attempt and a finished one answer different questions. A finished
 * one is judged by what it cost, which `describeCost` says. A running one is
 * judged by whether it is still getting anywhere — so it gets the clock and
 * the worker's current activity instead, the same two things the canvas shows.
 */
export function describeAttempt(
  attempt: {
    nodeId: string;
    attempt: number;
    status: string;
    childThreadId: string | null;
    startedAt: number | null;
    endedAt: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    activity?: string | null;
  },
  now: number,
): string {
  const running = attempt.status === "running";
  const live =
    running && attempt.startedAt !== null
      ? [`running ${elapsedLabel(attempt.startedAt, now)}`, attempt.activity ?? ""]
          .filter((part) => part !== "")
          .join(" · ")
      : describeCost(attempt);
  return [
    `  ${attempt.status.padEnd(8)} ${attempt.nodeId} (attempt ${attempt.attempt})`,
    live,
    attempt.childThreadId ? `→ ${attempt.childThreadId}` : "",
  ]
    .filter((part) => part !== "")
    .join("  ");
}

/**
 * The run's own total, or "" when nothing was measured. Deliberately silent
 * rather than "0 tokens": a run whose workers reported nothing has not been
 * shown to be free, and a summary line is where that lie would be believed.
 */
export function runTotal(
  runs: ReadonlyArray<{ inputTokens: number | null; outputTokens: number | null }>,
): string {
  const measured = runs.filter(
    (run) => run.inputTokens !== null || run.outputTokens !== null,
  );
  if (measured.length === 0) return "";
  const total = measured.reduce(
    (sum, run) => sum + (run.inputTokens ?? 0) + (run.outputTokens ?? 0),
    0,
  );
  const missing = runs.length - measured.length;
  return `Total: ${
    total >= 1000 ? `${(total / 1000).toFixed(1)}k tokens` : `${total} tokens`
  } across ${measured.length} node runs${
    // Saying so keeps the total from reading as the whole truth.
    missing > 0 ? ` (${missing} unmeasured)` : ""
  }`;
}

/**
 * One line per graph: enough to pick one, not enough to work with it.
 *
 * Grouped, because the library holds two unlike things plus whatever people
 * saved themselves, and twenty entries in one column say nothing about which
 * is which. Own graphs come first — they are what the reader was most likely
 * looking for.
 */
export function describeLibrary(graphs: Graph[]): string {
  if (graphs.length === 0) return "No graphs.";
  const width = Math.max(...graphs.map((graph) => graph.id.length), 20);
  const nameWidth = Math.max(...graphs.map((graph) => graph.name.length), 20);
  return groupedLibrary(graphs)
    .map(
      (section) =>
        `${section.label}\n` +
        section.graphs
          .map((graph) => {
            // The pattern is what somebody searching actually knows: "voting",
            // "orchestrator–worker". Neither word is in the name.
            const pattern = templatePattern(graph.id);
            return (
              `  ${graph.id.padEnd(width)} ${graph.nodes.length} nodes  ` +
              (pattern ? `${graph.name.padEnd(nameWidth)}  ${pattern}` : graph.name)
            );
          })
          .join("\n"),
    )
    .join("\n\n");
}

function describeNode(node: GraphNode): string {
  const execution = nodeExecution(node);
  return (
    `  [${node.kind}] ${node.id} — ${node.label}` +
    (node.skills.length > 0 ? `  skills: ${node.skills.join(", ")}` : "") +
    (node.fields.length > 0
      ? `  fields: ${node.fields
          .map((field) =>
            field.type === "enum"
              ? `${field.name}(${field.options.join("|")})`
              : `${field.name}:${field.type}`,
          )
          .join(", ")}`
      : "") +
    (node.kind === "subgraph" ? `  graph: ${node.graphId}` : "") +
    (node.kind === "member" ? `  member: ${node.member.trim() || "(none)"}` : "") +
    // Without this the listing shows the same edges for an exclusive choice
    // and an inclusive or, and the two behave completely differently.
    (node.routing === "every" ? "  every matching branch" : "") +
    (node.maxVisits > 1 ? `  max ${node.maxVisits}×` : "") +
    // Whether a failure here ends the run is the difference between a graph
    // that stops and one that has a fallback; the edges alone do not say it.
    (node.onError === "route" ? "  routes its failure" : "") +
    // Two nodes of the same kind behaving differently is only explicable if
    // the listing says which one runs on its own model.
    (execution ? `  model: ${execution.providerId}/${execution.model}` : "")
  );
}

function describeEdge(edge: GraphEdge, maxFanOut: number): string {
  // A fan-out is one printed arrow standing for n branches; say so, or the
  // listing reads as a plain hand-off.
  const fan =
    fanOutKey(edge) !== ""
      ? `  per entry in ${fanOutKey(edge)} (max ${maxFanOut})`
      : "";
  // A handoff's real target is not in `to`, so a line without this would name
  // the fallback as if it were the destination.
  const handoff =
    handoffKey(edge) !== ""
      ? `  target from ${handoffKey(edge)}, else ${edge.to}`
      : "";
  // `failed` and `succeeded` ask about a node's outcome, not its text, and
  // carry no comparison value — printed in the shape of the other conditions
  // they would read as "text(build) failed", which names the wrong thing.
  const when = !edge.when
    ? ""
    : edge.when.op === "failed" || edge.when.op === "succeeded"
      ? `  if ${edge.when.key || edge.from} ${edge.when.op}`
      : `  if ${
          edge.when.source === "field"
            ? edge.when.key
            : `text(${edge.when.key || edge.from})`
        } ${edge.when.op} ${edge.when.value}`;
  return `  ${edge.from} → ${edge.to}${fan}${handoff}${when}`;
}

/** The full short form: nodes, edges, and what the validator has to say. */
export function describeGraph(graph: Graph, problems: GraphProblem[]): string {
  return [
    `${graph.name} (${graph.id})`,
    graph.description,
    // The one line that answers "is this the graph for what I have in front
    // of me" — the description says how the graph works, not what it is fed.
    ...(graph.example ? [`Example: ${runCommand(graph)}`] : []),
    "",
    ...graph.nodes.map(describeNode),
    "",
    ...graph.edges.map((edge) => describeEdge(edge, graph.maxFanOut)),
    "",
    // A clean graph must say that it is clean. Silence here is ambiguous:
    // it reads the same as "the check never ran".
    ...(problems.length > 0
      ? problems.map((problem) => `  ${problem.level}: ${problem.message}`)
      : ["  Check found nothing."]),
  ].join("\n");
}

/**
 * The CLI line that starts this graph, ready to paste into a terminal.
 *
 * Built here rather than in the panel so the string the UI offers to copy and
 * the usage the CLI prints come from one place — a copy button that hands out
 * a command with the wrong quoting is worse than no button, because it fails
 * in the terminal where nothing explains why.
 *
 * The task falls back to the graph's own `example`: a placeholder like
 * "<task>" teaches the syntax and nothing about what to put in it.
 */
export function runCommand(
  graph: Pick<Graph, "id" | "example">,
  task?: string,
): string {
  // A graph without an example falls back to the placeholder, not to an empty
  // argument: `run my-graph ""` is a line that runs and starts a graph with
  // no task, which is worse than a line that visibly wants filling in.
  const text = (task ?? "").trim() || graph.example.trim() || "<task>";
  return `bb graph-studio run ${graph.id || "<graph-id>"} ${shellQuote(text)}`;
}

/**
 * Double quotes, because a task is prose and single quotes would make every
 * "doesn't" a syntax error. That leaves four characters the shell still reads
 * inside double quotes, and all four have to be escaped.
 */
export function shellQuote(text: string): string {
  return `"${text.replace(/([\\"$`])/g, "\\$1")}"`;
}
