// The runtime: a declarative graph becomes a LangGraph StateGraph whose nodes
// spawn BB threads.
//
// Division of labour, per the design this plugin was asked for:
//   LangGraph owns state, edges, cycles, checkpointing.
//   BB owns execution — threads, worktrees, providers, permissions.
// So a node is never a model call. It is "spawn a BB thread, wait for it to go
// idle, put its last message into the state". That keeps every unit of work
// visible in the sidebar and on the user's existing provider subscriptions,
// instead of needing separate API keys.
import {
  Annotation,
  END,
  START,
  Send,
  StateGraph,
  interrupt,
  isGraphBubbleUp,
  type CompiledStateGraph,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  END_NODE,
  START_NODE,
  composeDialogPrompt,
  composeNodePrompt,
  parseDialogTurn,
  emptyRunState,
  edgeTargets,
  fanOutEdge,
  fanOutKey,
  handoffKey,
  handoffTargets,
  mergeCollected,
  parseFields,
  reachableNodeIds,
  entryNode,
  isFanOut,
  nodeExecution,
  renderPrompt,
  resolveFanOut,
  joinGroups,
  routeAll,
  routeFrom,
  type CollectedResult,
  type FieldValue,
  type Graph,
  type GraphResolver,
  type NodeExecution,
  type RunState,
} from "./graph";

/** How the runtime reaches BB. Narrow on purpose, so it can be faked in tests. */
export type RuntimeHost = {
  /** Spawn a worker thread and return its id. */
  spawn(args: {
    prompt: string;
    title: string;
    nodeId: string;
    skills: string[];
    /** Explicit provider/model, or null to inherit the parent thread. */
    execution: NodeExecution | null;
  }): Promise<string>;
  /** Resolve with the thread's final assistant text, or reject if it failed. */
  awaitThread(threadId: string): Promise<string>;
  /** Dialogue nodes: send the user's answer into the worker's own thread. */
  sendMessage(threadId: string, text: string): Promise<void>;
  /**
   * Dialogue nodes: the conversation already open for this visit, and how
   * many messages the graph has sent into it. Read before anything is
   * spawned, because an `interrupt()` replay re-enters the node from the top.
   */
  loadDialog(
    nodeId: string,
    visit: number,
  ): Promise<{ threadId: string; turns: number } | null>;
  saveDialog(
    nodeId: string,
    visit: number,
    session: { threadId: string; turns: number },
  ): Promise<void>;
  /** Record-keeping hooks; all persistence lives outside the runtime. */
  onNodeStart(nodeId: string): Promise<string>;
  /**
   * The worker this attempt got, reported the moment it exists rather than
   * with the result. Everything a reader wants during the minutes a node runs
   * — the link into the thread, and what that thread is doing — hangs off this
   * id, and reporting it at the end would make all of it retrospective.
   */
  onNodeThread(nodeRunId: string, threadId: string): Promise<void>;
  onNodeFinish(
    nodeRunId: string,
    patch: {
      status: "done" | "failed";
      childThreadId: string | null;
      output: string | null;
      error: string | null;
    },
  ): Promise<void>;
  onStateChange(state: RunState): Promise<void>;
  log(message: string): void;
  /**
   * Backoff between the attempts the runtime counts itself — see the retry
   * loop for why those exist. Optional so a test can hand in a no-op and not
   * spend seconds asleep proving that a node gave up.
   */
  wait?(ms: number): Promise<void>;
};

/** Thrown when a guard stops the run; carries no stack noise into the UI. */
export class GuardStop extends Error {}

/** Backoff when the host does not supply one. */
const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** For log lines: the label a reader sees on the canvas, not the id. */
function nodeLabel(graph: Graph, nodeId: string): string {
  return graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

const StateAnnotation = Annotation.Root({
  input: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
  // Merge reducers: parallel branches each contribute their own keys, so a
  // fan-out does not lose the outputs of the branches that finish first.
  outputs: Annotation<Record<string, string>>({
    reducer: (previous, next) => ({ ...previous, ...next }),
    default: () => ({}),
  }),
  fields: Annotation<Record<string, Record<string, FieldValue>>>({
    reducer: (previous, next) => ({ ...previous, ...next }),
    default: () => ({}),
  }),
  // Branch results of a dynamic fan-out. `outputs` cannot carry these: it
  // merges by key, so n instances of one node would leave one survivor.
  collected: Annotation<Record<string, CollectedResult[]>>({
    reducer: (previous, next) => {
      const merged = { ...previous };
      for (const [key, value] of Object.entries(next)) {
        merged[key] = mergeCollected(merged[key] ?? [], value);
      }
      return merged;
    },
    default: () => ({}),
  }),
  // Why a node gave up, for the nodes that route their failure onward. Merged
  // like `outputs`, and cleared with an empty string when the node later
  // succeeds — a stale entry here would keep a `failed` edge firing forever.
  errors: Annotation<Record<string, string>>({
    reducer: (previous, next) => ({ ...previous, ...next }),
    default: () => ({}),
  }),
  // The element an instance was fanned out with. Last write wins: outside a
  // fan-out nothing reads it, and inside it each instance gets its own via
  // `Send`, never through the reducer.
  item: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
  visits: Annotation<Record<string, number>>({
    // Visit counts add up across branches rather than overwriting.
    reducer: (previous, next) => {
      const merged = { ...previous };
      for (const [key, value] of Object.entries(next)) {
        merged[key] = Math.max(merged[key] ?? 0, value);
      }
      return merged;
    },
    default: () => ({}),
  }),
  steps: Annotation<number>({
    reducer: (previous, next) => Math.max(previous, next),
    default: () => 0,
  }),
});

type State = typeof StateAnnotation.State;

function asRunState(state: State): RunState {
  return {
    input: state.input,
    outputs: state.outputs,
    fields: state.fields,
    collected: state.collected,
    errors: state.errors,
    item: state.item,
    visits: state.visits,
    steps: state.steps,
  };
}

export function compileGraph(
  graph: Graph,
  host: RuntimeHost,
  checkpointer?: BaseCheckpointSaver,
  resolve: GraphResolver = () => null,
): CompiledStateGraph<State, Partial<State>, string> {
  const builder = new StateGraph(StateAnnotation);

  // The node names a placeholder may legitimately carry. Anything else in
  // `{{…}}` is a typo and stays standing, which is what the validator's dead
  // wiring error rests on; a known name that has not run yet renders empty,
  // because a back edge reads it before it is written. Subgraph nodes are in
  // here too — an embedded graph shares this state.
  const knownNodes = new Set(
    (reachableNodeIds(graph, resolve) ?? new Map(graph.nodes.map((node) => [node.id, graph.id])))
      .keys(),
  );

  // Nodes reached by a dynamic fan-out write their result into `collected`
  // instead of `outputs`, because several instances of them run at once.
  const fanOutTargets = new Set(
    graph.edges
      .filter((edge) => fanOutKey(edge) !== "")
      .map((edge) => edge.to),
  );

  for (const node of graph.nodes) {
    // A subgraph is added as a compiled graph, not as a function that invokes
    // one. The difference decides whether the feature works at all: a nested
    // `invoke()` *returns* `__interrupt__` in its result instead of throwing,
    // so a question inside the child would be recorded as its answer and the
    // parent would walk on — the dialogue-node bug one level up. Added this
    // way, LangGraph propagates the interrupt into the parent's own tasks, and
    // `Command({ resume })` reaches across the boundary untouched.
    if (node.kind === "subgraph") {
      const child = resolve(node.graphId);
      if (!child) {
        throw new Error(
          `"${node.label}" embeds the graph "${node.graphId}", which does not exist.`,
        );
      }
      // No checkpointer for the child: the parent's is the one that owns this
      // run, and LangGraph namespaces the child's checkpoints beneath it.
      builder.addNode(node.id, compileGraph(child, host, undefined, resolve));
      continue;
    }

    // A human node must never be retried: `interrupt()` throws by design to
    // suspend the graph, and a retry policy would treat that as a failure.
    //
    // A node that routes its failure gets no policy either, and counts its own
    // attempts below. LangGraph's retry ends in a throw by construction — that
    // is what a retry policy *is* — so a node whose last attempt must return
    // rather than throw cannot hand the counting over. The two ways of
    // retrying therefore never apply to the same node.
    //
    // `GuardStop` is excluded from the retry on purpose: a stop (or a guard
    // limit) is the run asking to end, not a flaky attempt. Retrying it would
    // burn the backoff delays — three attempts at growing intervals — on a
    // result that is already decided.
    const retryPolicy =
      node.kind === "agent" && node.maxAttempts > 1 && node.onError !== "route"
        ? {
            maxAttempts: node.maxAttempts,
            initialInterval: 1_000,
            jitter: true,
            retryOn: (cause: unknown) => !(cause instanceof GuardStop),
          }
        : undefined;

    builder.addNode(node.id, async (state: State) => {
      const runState = asRunState(state);
      const visits = (state.visits[node.id] ?? 0) + 1;
      const steps = state.steps + 1;

      if (visits > node.maxVisits) {
        throw new GuardStop(
          `"${node.label}" has reached its limit of ${node.maxVisits} visits.`,
        );
      }
      if (steps > graph.maxSteps) {
        throw new GuardStop(
          `The run has reached its overall limit of ${graph.maxSteps} steps.`,
        );
      }

      // A note node documents the graph and does no work.
      if (node.kind === "note") {
        return { visits: { [node.id]: visits }, steps };
      }

      // A human node stops the graph. LangGraph checkpoints here, so the
      // answer can arrive minutes or days later, across a plugin reload.
      if (node.kind === "human") {
        const answer = interrupt({
          nodeId: node.id,
          label: node.label,
          question: renderPrompt(node.prompt || node.label, runState, knownNodes),
        }) as string;
        return {
          outputs: { [node.id]: String(answer ?? "") },
          visits: { [node.id]: visits },
          steps,
        };
      }

      // A dialogue node keeps one worker thread open and takes turns with the
      // user: the worker asks, `interrupt()` suspends the graph, the answer
      // goes back into the same thread. An `agent` node cannot do this — it
      // waits for idle, and a worker waiting for an answer *is* idle, so its
      // question would be recorded as the result and the graph would move on
      // without anyone having replied.
      if (node.kind === "dialog") {
        const nodeRunId = await host.onNodeStart(node.id);
        let session = await host.loadDialog(node.id, visits);
        try {
          if (!session) {
            const threadId = await host.spawn({
              prompt: composeDialogPrompt(node, runState, knownNodes),
              title: node.label.slice(0, 80),
              nodeId: node.id,
              skills: node.skills,
              execution: nodeExecution(node),
            });
            session = { threadId, turns: 0 };
            await host.saveDialog(node.id, visits, session);
          }
          const threadId = session.threadId;
          // Outside the `if` above: a replay re-enters the node with the
          // conversation already loaded, and the row still wants to name it.
          await host.onNodeThread(nodeRunId, threadId);
          // Messages already delivered before this (possibly replayed) pass.
          // Re-sending them would duplicate the conversation.
          const alreadySent = session.turns;
          let sent = 0;

          /**
           * Send only what this pass has not delivered before, and say
           * whether it went out. A replay walks back through the answers it
           * already sent, and re-sending them would say everything twice.
           */
          const say = async (text: string): Promise<boolean> => {
            sent += 1;
            if (sent <= alreadySent) return false;
            await host.sendMessage(threadId, text);
            await host.saveDialog(node.id, visits, { threadId, turns: sent });
            return true;
          };

          let message = await host.awaitThread(threadId);
          for (;;) {
            const turn = parseDialogTurn(message);
            if (turn.done) break;
            if (sent >= node.maxTurns) {
              // Not an error: an interview that runs long has still produced
              // something. Ask for the summary instead of losing the thread.
              await say(
                "We are at this step's turn limit. Summarise the shared understanding now, name open points as open, and answer with `done: true`.",
              );
              message = await host.awaitThread(threadId);
              break;
            }
            const answer = interrupt({
              nodeId: node.id,
              label: node.label,
              question: turn.question,
            }) as string;
            const delivered = await say(String(answer ?? ""));
            const before = message;
            message = await host.awaitThread(threadId);
            // The same message after something was actually sent means the
            // worker never took the answer up — asking the user the identical
            // question forever is worse than stopping, and the run can be
            // resumed from here. On a replay nothing is sent, and then an
            // unchanged message is exactly what is expected.
            if (delivered && message === before) {
              throw new Error(
                `"${node.label}" did not react to the answer; the thread is unchanged.`,
              );
            }
          }

          const fields = parseFields(node.fields, message);
          await host.onNodeFinish(nodeRunId, {
            status: "done",
            childThreadId: threadId,
            output: message,
            error: null,
          });
          await host.onStateChange({
            ...runState,
            outputs: { ...runState.outputs, [node.id]: message },
            fields: { ...runState.fields, [node.id]: fields },
            ...(node.onError === "route"
              ? { errors: { ...runState.errors, [node.id]: "" } }
              : {}),
            visits: { ...runState.visits, [node.id]: visits },
            steps,
          });
          return {
            outputs: { [node.id]: message },
            ...(node.fields.length > 0 ? { fields: { [node.id]: fields } } : {}),
            ...(node.onError === "route" ? { errors: { [node.id]: "" } } : {}),
            visits: { [node.id]: visits },
            steps,
          };
        } catch (cause) {
          // `interrupt()` throws to suspend — that is not a failed node, and
          // recording it as one would leave a lie in the run history.
          if (isGraphBubbleUp(cause)) throw cause;
          const raw = cause instanceof Error ? cause.message : String(cause);
          const message =
            raw.trim() === "" ? "The node failed without a message." : raw;
          await host.onNodeFinish(nodeRunId, {
            status: "failed",
            childThreadId: session?.threadId ?? null,
            output: null,
            error: message,
          });
          // A stop is recorded like any failed attempt above, but it is not a
          // failure to route around: the run asked to end, so no failure edge
          // applies and the error propagates to the run.
          if (cause instanceof GuardStop) throw cause;
          if (node.onError !== "route") throw cause;
          // Same bargain as an agent node, minus the retry: a dialogue is a
          // conversation with a person in it, and starting it over from the
          // first question is not a retry of anything.
          host.log(
            `"${node.label}" failed: ${message}. The run carries on along its failure edge.`,
          );
          await host.onStateChange({
            ...runState,
            errors: { ...runState.errors, [node.id]: message },
            visits: { ...runState.visits, [node.id]: visits },
            steps,
          });
          return {
            errors: { [node.id]: message },
            visits: { [node.id]: visits },
            steps,
          };
        }
      }

      // The attempt number is owned by the host: LangGraph re-invokes this
      // function on a retry with the same state, so deriving it from `visits`
      // would label every retry as the same attempt.
      const attempt = async (): Promise<Partial<State>> => {
        const nodeRunId = await host.onNodeStart(node.id);
        let childThreadId: string | null = null;
        try {
          childThreadId = await host.spawn({
            prompt: composeNodePrompt(node, runState, knownNodes),
            title: node.label.slice(0, 80),
            nodeId: node.id,
            skills: node.skills,
            execution: nodeExecution(node),
          });
          await host.onNodeThread(nodeRunId, childThreadId);
          const output = await host.awaitThread(childThreadId);
          // Parsing before recording: a broken contract is a failed attempt, so
          // the retry policy gives the worker another go instead of writing
          // half-understood text into the state.
          const fields = parseFields(node.fields, output);
          await host.onNodeFinish(nodeRunId, {
            status: "done",
            childThreadId,
            output,
            error: null,
          });
          // One branch of a fan-out contributes to a list; a node that ran once
          // owns its output outright. Writing both would be worse than either:
          // `outputs` would hold whichever branch happened to finish last and
          // look like the node's result.
          const collects = fanOutTargets.has(node.id);
          const next: Partial<State> = {
            ...(collects
              ? { collected: { [node.id]: [{ visit: visits, text: output }] } }
              : {
                  outputs: { [node.id]: output },
                  ...(node.fields.length > 0 ? { fields: { [node.id]: fields } } : {}),
                }),
            // Only for a node that can leave an error behind: on a cycle's next
            // lap this is what takes the old failure back off the state.
            ...(node.onError === "route" ? { errors: { [node.id]: "" } } : {}),
            visits: { [node.id]: visits },
            steps,
          };
          await host.onStateChange({
            ...runState,
            ...(collects
              ? {
                  collected: {
                    ...runState.collected,
                    [node.id]: mergeCollected(runState.collected[node.id] ?? [], [
                      { visit: visits, text: output },
                    ]),
                  },
                }
              : {
                  outputs: { ...runState.outputs, [node.id]: output },
                  fields: { ...runState.fields, [node.id]: fields },
                }),
            ...(node.onError === "route"
              ? { errors: { ...runState.errors, [node.id]: "" } }
              : {}),
            visits: { ...runState.visits, [node.id]: visits },
            steps,
          });
          return next;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          await host.onNodeFinish(nodeRunId, {
            status: "failed",
            childThreadId,
            output: null,
            error: message,
          });
          throw cause;
        }
      };

      if (node.onError !== "route") return await attempt();

      // The node counts its own attempts, because the last one has to end in
      // a return rather than a throw. The failure is recorded in the state and
      // the graph carries on: an edge with the `failed` condition is what
      // decides where. Nothing is written to `outputs`, so `{{node}}` renders
      // empty downstream — there is no result to pretend about.
      let lastError = "";
      for (let tries = 1; tries <= node.maxAttempts; tries += 1) {
        try {
          return await attempt();
        } catch (cause) {
          if (isGraphBubbleUp(cause)) throw cause;
          // Same as in the dialogue node above: a stop ends the run, it is not
          // a failure this node may retry or route around.
          if (cause instanceof GuardStop) throw cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          // The empty string is how this state says "did not fail", so a
          // failure without a message must not be recorded as one.
          lastError = message.trim() === "" ? "The node failed without a message." : message;
          if (tries < node.maxAttempts) {
            await (host.wait ?? defaultWait)(1_000 + Math.random() * 1_000);
          }
        }
      }
      host.log(
        `"${node.label}" gave up after ${node.maxAttempts} ${node.maxAttempts === 1 ? "attempt" : "attempts"}: ${lastError}. The run carries on along its failure edge.`,
      );
      await host.onStateChange({
        ...runState,
        errors: { ...runState.errors, [node.id]: lastError },
        visits: { ...runState.visits, [node.id]: visits },
        steps,
      });
      return {
        errors: { [node.id]: lastError },
        visits: { [node.id]: visits },
        steps,
      };
    }, retryPolicy ? { retryPolicy } : undefined);
  }

  // Entry.
  const entry = entryNode(graph);
  if (entry !== END_NODE) {
    builder.addEdge(START, entry as never);
  }

  // Structured joins, wired as one edge with several sources. Added
  // separately because the engine starts a node as soon as *one* incoming
  // edge delivers: with a plain edge per branch, a join behind branches of
  // unequal length runs once per branch, and its first run reads a state the
  // longer branch has not written yet. `joinSources` only reports joins where
  // every branch is guaranteed to arrive, so this cannot deadlock.
  /**
   * Every node an outgoing edge set can deliver to, plus END.
   *
   * A handoff edge contributes its declared candidates as well as its
   * fallback: LangGraph refuses to route anywhere it was not told about, so a
   * target missing here would turn the worker's choice into a crash rather
   * than a route. END belongs in it even when no edge draws it — routing lands
   * there when nothing matches, or when every matching edge led into a node
   * that is out of visits.
   */
  const routableTargets = (out: typeof graph.edges): string[] => {
    const named = out.flatMap((edge) =>
      edgeTargets(graph, edge).map((id) => (id === END_NODE ? END : id)),
    );
    // A handoff whose successors are not declared — the free-text form — can
    // go anywhere, so everywhere has to be listed. Not a nicety: LangGraph
    // refuses to compile a graph containing a node nothing routes to, and the
    // nodes such a swarm hands off to are reached by nothing else. This is the
    // concrete shape of the price `validateGraph` warns about, and it is
    // confined to the node that hands off: the rest of the graph keeps its
    // unreachable-node check.
    const open = out.some(
      (edge) => handoffKey(edge) !== "" && handoffTargets(graph, edge).length === 0,
    );
    const all = open ? graph.nodes.map((node) => node.id) : [];
    return [...new Set([...named, ...all, END])];
  };

  /**
   * A handoff is the one routing decision a reader cannot reconstruct from the
   * drawing, so it is the one that has to be in the log — both when the worker
   * named a node and when it named something else and the fallback took over.
   */
  const logHandoff = (
    label: string,
    choice: { wanted: string; used: string; resolved: boolean },
  ) => {
    const onward =
      choice.used === END_NODE
        ? "the run ends here"
        : `the run carries on to "${nodeLabel(graph, choice.used)}"`;
    host.log(
      choice.resolved
        ? `"${label}" handed off to "${nodeLabel(graph, choice.used)}".`
        : choice.wanted === ""
          ? `"${label}" named no successor; ${onward}.`
          : `"${label}" named "${choice.wanted}", which is no node in this graph; ${onward}.`,
    );
  };

  const joins = joinGroups(graph);
  for (const [target, sources] of joins) {
    builder.addEdge(sources as never, target as never);
  }

  // Edges. A node with several unconditional targets fans out; anything else
  // routes to exactly one target, which is what makes cycles expressible.
  for (const node of graph.nodes) {
    const out = graph.edges.filter((edge) => edge.from === node.id);
    if (out.length === 0) {
      builder.addEdge(node.id as never, END);
      continue;
    }
    // Edges already covered by a join edge above must not be added again: a
    // second, single-source edge to the same target would reinstate exactly
    // the early start the join edge exists to prevent.
    const joined = out.filter((edge) => joins.get(edge.to)?.includes(node.id));
    if (joined.length === out.length) continue;
    // Dynamic fan-out: the branch count is a value in the state, so it can
    // only be known here, at routing time. `Send` starts one instance of the
    // target per element, each with its own slice of state.
    const dynamic = fanOutEdge(graph, node.id);
    if (dynamic) {
      const target = dynamic.to === END_NODE ? END : dynamic.to;
      builder.addConditionalEdges(
        node.id as never,
        (state: State) => {
          const { items, dropped } = resolveFanOut(graph, dynamic, asRunState(state));
          if (dropped > 0) {
            host.log(
              `"${node.label}" fans out over ${items.length} of ${items.length + dropped} entries; ${dropped} skipped (maxFanOut ${graph.maxFanOut}).`,
            );
          }
          // Nothing to branch over is a legitimate outcome ("no file changed"),
          // but there is no path onward either — every route out of here runs
          // through the target. Ending is the honest answer; saying so in the
          // log keeps it from looking like a lost run.
          if (items.length === 0) {
            host.log(`"${node.label}" has nothing to fan out over; the run ends here.`);
            return END;
          }
          return items.map((item) => new Send(target as string, { ...state, item }));
        },
        [target, END] as never,
      );
      continue;
    }
    if (isFanOut(graph, node.id)) {
      for (const edge of out) {
        builder.addEdge(
          node.id as never,
          (edge.to === END_NODE ? END : edge.to) as never,
        );
      }
      continue;
    }
    // Inclusive or: every edge whose condition holds is taken, and the engine
    // runs those branches in the same superstep. A routing function may return
    // a list, so this needs no other machinery than saying so.
    if (node.routing === "every") {
      const targets = routableTargets(out);
      builder.addConditionalEdges(
        node.id as never,
        (state: State) => {
          const { next, skipped, handoffs } = routeAll(graph, node.id, asRunState(state));
          for (const choice of handoffs) logHandoff(node.label, choice);
          for (const edge of skipped) {
            host.log(
              `"${node.label}" would have routed to "${edge.label}", but its limit of ${edge.maxVisits} visits is reached; that branch is dropped.`,
            );
          }
          // No branch chosen is a legitimate outcome of an inclusive or —
          // every condition may simply be false. Ending is the honest answer.
          if (next.length === 0) {
            host.log(`"${node.label}" chose no branch; the run ends here.`);
            return END;
          }
          return next as string[];
        },
        targets as never,
      );
      continue;
    }

    // END belongs in the target list even when no edge draws it: routing can
    // land there when nothing matches, or when every matching edge led into a
    // node that is out of visits.
    const targets = routableTargets(out);
    builder.addConditionalEdges(
      node.id as never,
      (state: State) => {
        const { next, skipped, handoffs } = routeFrom(graph, node.id, asRunState(state));
        for (const choice of handoffs) logHandoff(node.label, choice);
        for (const edge of skipped) {
          const onward =
            next === END_NODE
              ? "the run ends here"
              : `it carries on to "${nodeLabel(graph, next)}"`;
          host.log(
            `"${node.label}" would have routed to "${edge.label}", but its limit of ${edge.maxVisits} visits is reached; ${onward}.`,
          );
        }
        return (next === END_NODE ? END : next) as string;
      },
      targets as never,
    );
  }

  return builder.compile({ checkpointer }) as never;
}

export { StateAnnotation, emptyRunState, START_NODE, END_NODE };
