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
