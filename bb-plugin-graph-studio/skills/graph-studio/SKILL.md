---
name: graph-studio
description: Design, change or run a Graph Studio flow in natural language — "build me a flow that …", "add a review step to review-flow", "run concept-feature on …". Use whenever the user wants an agent graph (steps, loops, approvals, parallel branches) created, edited, explained or started.
---

# Graph Studio from the chat

Graph Studio runs agent graphs: every node is a fresh BB thread, edges route on
results, cycles are allowed. The user designs flows **here, in the chat**; the
studio (panel → Edit, full screen) is where they review and fine-tune.

## Tools

| Tool | For |
| --- | --- |
| `graph_studio_graphs` | the library: id, size, name |
| `graph_studio_describe` | what one graph does, with the validator's findings |
| `graph_studio_get` | one graph as JSON — read before writing or changing |
| `graph_studio_save` | create or replace a graph from JSON; returns problems |
| `graph_studio_run` | start a run (`input` is all the run will know) |
| `graph_studio_status` / `graph_studio_answer` | follow a run, answer an approval |

## Creating a flow

1. **Understand the job.** What goes in, what should come out, where a human
   must decide, what may loop. Ask only if the answer changes the graph.
2. **Start from something close.** `graph_studio_graphs`, then
   `graph_studio_get` on the nearest template — reuse its structure and prompt
   style rather than inventing a format.
3. **Write the graph.** Keep it small: every node is a thread that costs time.
   - Give each node one job and a prompt that says what to produce.
     `{{input}}` is the task, `{{node_id}}` an earlier node's result.
   - Route on **result fields** (`fields` + an edge `when` with
     `source: "field"`), not on words in prose.
   - A loop needs an exit: a condition that ends it and a `maxVisits` on the
     node it returns to.
   - A human decision is a `human` node; a back-and-forth with the user is a
     `dialog` node.
   - To reuse another graph, add a `subgraph` node with `graphId` — it works
     like an import: its nodes run in place and share the state; later nodes
     read their ids. Node ids must not collide with the imported graph's.
   - Leave `providerId`/`model` out unless the user asks for a model — nodes
     then run on the thread's model.
   - Set `example` to a real task in the user's words.
4. **Save** with `graph_studio_save`. If it reports errors, fix and save again.
   Never present a graph as done while it has errors.
5. **Report briefly**: what each node does, where it loops or waits, and how to
   use it. Offer both routes:
   - run it here: "say *run it on …*" (then `graph_studio_run`)
   - review it: "Graph Studio → Edit opens it in full screen"

## Changing a flow

Always `graph_studio_get` first — `graph_studio_save` replaces the whole graph.
Change only what was asked, keep ids stable (other nodes and edges refer to
them), save with `overwrite: true`, and say what changed. Positions the user
arranged in the studio are kept when your JSON has none.

## Running

`graph_studio_run` with an `input` that carries everything the run needs: the
task, constraints agreed here, what was ruled out, relevant file paths. The
workers do not see this conversation. Put the `::graph-run{…}` line the tool
returns into your reply so the user can watch the run.

## On the command line

```sh
bb graph-studio graphs
bb graph-studio show <graph-id>
bb graph-studio run <graph-id> "<task>"
bb graph-studio export <graph-id> > flow.json
bb graph-studio import flow.json
```

## Deterministic script execution

For an approved automated assignment, use the script CLI directly. Read the complete context tuple with `bb graph-studio execution --thread ID
--json`. Inspect `run --help`, `runs --help`, and `status --help` for options.
Supply an immutable assignment id, expected complete execution tuple, plus
explicit project, worker environment request, and execution context thread. The context thread supplies provider inheritance;
launching through this CLI does not submit a turn to it.

`--input-file` reads UTF-8 from the invoking machine through the SDK. Use an
absolute path when the caller has no cwd. `--json` returns `{run: RunDto}` for
launch/status and `{runs: RunDto[]}` for listing or exact assignment lookup.
Results include graph snapshot, assignment/environment ids, all state fields,
node attempts, and errors. Engine `done` alone does not establish integration.

Persist launch intent before invoking. Recover a lost response with exact
project/assignment lookup, which searches beyond the recent-run list. A repeat
launch of the same request returns its existing run, including failed runs;
changed input, graph id, thread, environment request, or execution is rejected.
`--execution-json` checks the assignment snapshot before any graph dispatch. An interrupted accepted run retains identity and diagnostics; the existing
runtime may resume its persisted checkpoint after reload. Treat
unreadable lookup or absent/ambiguous evidence as a recovery decision, preserving
ownership until inspected; automatic replacement can duplicate work.


Supply the worker environment independently of the execution context thread:
`--environment` uses an existing environment; `--host` plus absolute `--workspace`
resolves an unmanaged task workspace when the first actual graph worker starts.
The immutable `environmentRequest` remains available even before an environment
ID exists. Subsequent workers reuse the first worker's resolved environment ID.
The existing context thread supplies execution settings and receives no relay turn.

Correlated launches freeze the complete tuple. Worker nodes inherit it, including
permissions; explicit node provider/model/reasoning/tier choices override their
corresponding fields. Existing uncorrelated runs retain their previous behavior.

Before a new correlated launch, the assigned host/environment's public catalogue
checks every effective worker tuple, including referenced subgraphs. Each query
specifies the effective provider. Missing/unavailable models/providers, unreadable
catalogues, unsupported reasoning/tier/permissions, and permissions above the
host ceiling reject acceptance. Only catalogue-authorized selected/custom models
are accepted. Workspace-scoped catalogues need an existing `--environment`; a
host-only request cannot establish workspace-specific availability. Worker
requests mark every frozen tuple field explicit, and recheck availability before
spawn. Accepted identity recovery remains possible during a later catalogue outage.

A selected model's nonempty reasoning-effort list is authoritative. The provider
reasoning ladder is a fallback when model options are absent; dispatch is refused
if neither authorizes the requested level.

Worker spawn acceptance may return before its environment resolves. The runtime
records the accepted child first, then waits through public thread/environment
reads for readiness and validates project/environment/host/worktree. An
unverifiable accepted worker remains named in failed status; it is never replaced
by node retries. Check that child is quiescent before releasing task ownership.
