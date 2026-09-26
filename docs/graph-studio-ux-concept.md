# Graph Studio — UX/UI concept by perspective

Status: 2026-09-26. Parts marked **done** are in the working tree.

## Direction (revised 2026-09-26)

- **Authoring happens in the chat, in natural language.** `/graph-studio Build
  me a flow that …` loads the plugin's skill; the agent reads a similar graph
  (`graph_studio_get`), writes JSON and saves it (`graph_studio_save`, which
  returns the validator's findings). `#` in the composer names a graph.
- **The side panel monitors.** A run's graph on the right, active nodes kept
  centred; approvals can be answered there. No editing in the panel.
- **The full-screen studio reviews and fine-tunes.** Movable nodes (positions
  stored with the graph, "Auto layout" to reset), a compact inspector: head,
  the facts a review starts with (model, skills, fields, edges, limits), then
  folded sections — Identity, Task/Import, Model, Skills, Result fields, Edges,
  Limits — and the copyable chat/CLI lines.
- **Subgraphs are imports.** The node says what it imports; "+" opens the
  imported graph in place on the canvas, live statuses included.

## Implementation status

| Perspective | Done | Open |
| --- | --- | --- |
| Entry | Task first; "Fits the task" suggestions (`lib/suggest.ts`); active runs on top; export/import moved to the end | Graph cards with thumbnails (the picker is already a searchable table) |
| Edit | Full screen by default for existing graphs; card tabs *Setup · Edges (n in / m out) · Execution (summary)*; kind as five icon buttons; undo/redo (⌘Z / ⇧⌘Z, coalesced) with "Unsaved changes"; leave guard; "+" on each edge splices a node in; edge click opens the Edges tab; embedded graph preview in subgraph cards | Clickable edge label opens that edge; drill-down with breadcrumb; resizable/switchable sidebar |
| Run | Timeline strip (visits in order, click → attempt; restart points on the same strip, replacing the folded list); inspector tabs *Attempts · Prompt · Fields*; follow mode with resume control; unreached nodes dimmed; visits shown as `2/3×`; Stop in the full-screen bar | Continue/Replay as top-bar buttons |
| Chat | Inline card `::graph-run{run="…"}` via `messageDirective`: live mini canvas, status, question with answer box, "Open in Graph Studio"; `graph_studio_run` tells the agent to include it | One shared compact run component for banner and card |

Graph Studio is used from four places, each with a different question on the
user's mind. The interface should answer that question first and keep
everything else one step away.

| Perspective | Question | Where |
| --- | --- | --- |
| 1. Entry | "Which graph fits my task, and how do I start it?" | Panel |
| 2. Edit | "What does this graph do, and how do I change it?" | Full screen |
| 3. Run | "Where is the work, what does it need from me?" | Panel ↔ full screen |
| 4. In the chat | "Is something running for this conversation?" | Composer banner, inline card |

Guiding rules for all four:

- **The graph is the interface.** Lists are secondary views of it.
- **One selection, one detail surface.** Click on the canvas → a card/sidebar
  with everything about that element. Never two lists that describe the same
  thing.
- **Nothing that takes effect may be hidden without a summary.** (The existing
  rule behind the collapsed "Execution" summary, applied everywhere.)
- **Functionality stays.** Every control that exists today keeps a home.

---

## 1. Entry (library)

Today: "Start a run" card, graph picker with grouped catalogue, preview canvas,
recent runs, export/import.

Proposal:

- **Task first.** One input at the top: "What do you want done?" Below it the
  graph picker, pre-sorted by the example tasks (`graph.example`) that match
  the text. The run command (CLI) stays as a secondary line.
- **Cards instead of a dropdown** for the picker once there are more than a
  handful of graphs: name, example task, node count, a thumbnail of the canvas
  (same layout, no labels). Templates and own graphs as two tabs.
- **Preview on demand**: selecting a card shows its canvas; "Edit" opens the
  editor (perspective 2), "Run" starts it.
- **Recent runs** as a compact list with status dot and "continue / replay".
- Export/import moves to a "…" menu per graph — it is a utility.

## 2. Edit (full screen)

**Done:** editing an existing graph opens in full screen; canvas left, editing
sidebar right. New graphs start in the panel (template picker and id live
there), with a "Full screen" button.

Layout:

```
┌ top bar: name · "2 problems" / "Runnable" · Save · Leave full screen ┐
│                                            │ sidebar (28rem)          │
│   canvas (React Flow, pan/zoom,            │ [Edit node ▾] [+ Node]   │
│   drag handle → new edge,                  │ problems (graph-wide)    │
│   click node → sidebar,                    │ ┌ card ───────────────┐  │
│   click edge → card of its source,         │ │ node problems       │  │
│   click empty → graph settings)            │ │ id · label · kind   │  │
│                                            │ │ prompt / subgraph   │  │
│                                            │ │ skills · fields     │  │
│                                            │ │ Incoming ▸ from X   │  │
│                                            │ │ Outgoing ▸ to Y     │  │
│                                            │ │ Execution (summary) │  │
│                                            │ └─────────────────────┘  │
└────────────────────────────────────────────┴──────────────────────────┘
```

**Done in this round:**

- Node chips (read as tabs) replaced by one **"Edit node" dropdown** + "+ Node".
  The canvas is the primary picker; the dropdown is the keyboard's.
- **Edges as one-line rows**: "to Beta · result contains OK", folded; unfold
  for all controls; a target button **jumps to the node at the other end**.
  A new edge opens unfolded. "How edges decide" is folded help.
- **Problems in the card**: the messages naming this node appear where they can
  be fixed.
- **Graph settings** (name, example, run command) in the sidebar when no node
  is selected.
- **Subgraph** explained in place (see below), with a list of the ids the
  embedded graph makes readable and a "Clear them" for prompt/fields left over
  from the previous kind.

**Next:**

- **Card sections as tabs**: *Setup* (id, label, kind, prompt/subgraph, skills,
  fields) · *Edges (2 in / 3 out)* · *Execution (summary)*. Keeps the card one
  screen tall; the tab label carries the summary so nothing hides silently.
- **Edge label on the canvas is clickable** and opens that edge unfolded (today
  a click opens the source's card).
- **Insert on edge**: hover an edge → "+" → new node spliced in between.
- **Kind picker as icons** with a one-line description each, instead of a
  select whose options are sentences.
- **Undo/redo** (draft history) and a "discard changes" — the editor holds a
  draft anyway.
- **Unsaved indicator** in the top bar, and a guard when leaving.
- **Subgraph drill-down**: double-click a subgraph node → read-only view of the
  embedded graph, breadcrumb back.
- Optional: sidebar side switchable (left/right), resizable.

## 3. Run (watch, replay, inspect)

**Done:** "Full screen" is a real layer over the window; canvas left, sidebar
right with the pending question (never hidden), error, and the node inspector.

**Next:**

- **Timeline strip** under the canvas: one tick per node visit in order; click
  a tick → inspector at that visit; checkpoints marked → "Replay from here".
  This merges today's separate "Replay from a step" list into the picture.
- **Travelled path emphasis**: dim nodes never reached, number the visits on
  cycling nodes ("2/3").
- **Inspector tabs**: *Prompt* · *Result* · *Fields* · *Thread* (open child
  thread). Long results collapsed with "show all".
- **Run controls in the top bar**: Stop, Continue (after approval), Replay.
- **Follow mode**: while running, the viewport pans to the active node unless
  the user has panned manually.

## 4. In the chat

Today: the banner above the composer shows the running graph, sub-agents and
steps, and leads back to the panel. This works well and stays.

Proposal — **inline visualisation**: when a run is started from a thread, the
agent's message carries a compact live card (mini canvas with status colours,
"3 of 7 done", the pending question with an answer box). Clicking it opens
perspective 3. The banner stays as the persistent pointer; the inline card is
the record in the conversation's history — after the run it freezes to the
final state and a link to replay.

---

## The subgraph feature, explained

A **subgraph node** embeds another graph at that point in the run:

1. When the run reaches the node, the embedded graph's nodes run **in place of
   it**, as part of the same run, sharing the same state.
2. When the embedded graph reaches its End, the run continues along the
   subgraph node's **outgoing edges**.
3. The subgraph node itself does no work and writes no result. Later nodes read
   the results of the **embedded nodes** by their ids (`{{explore}}`), not the
   subgraph node's id.

Why switching a node to Subgraph showed errors: nothing crashed, but the
validator reported problems the card could not fix — the prompt was hidden yet
still counted, other nodes still read `{{<this id>}}`, and no graph was chosen
yet. The card now explains the kind, shows these problems in place, and offers
to clear the leftovers. Node ids that exist both here and in the embedded graph
remain an error (shared state would overwrite one with the other).
