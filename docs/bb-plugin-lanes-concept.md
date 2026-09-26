# Lanes — a Kanban board for BB's built-in Tasks

Concept, 2026-09-19. Not yet implemented.

## Why

BB's built-in `tasks` plugin stores everything a board needs — six workflow
statuses, a manual `position`, labels, priorities, attached agent threads — and
renders none of it as a board. The only views are the list in the Tasks app and
`bb tasks list` on the command line.

The community plugin `taskboard` does render a Kanban board, but it reads
GitHub, Linear and Jira. It has no path to the local Tasks database, and it has
no GitLab source either. So neither covers the case this plugin is for: small
side projects — learning and concept work with no deployment — tracked locally
in BB, seen as columns.

Main projects stay where they are, in remote GitHub and GitLab. Lanes is
deliberately not a second tracker for those.

## Name

The plugin id is `lanes`, the folder `bb-plugin-lanes`.

Not `taskboard`: that id is taken by the community plugin, which may well be
installed alongside this one — it already is on the machine this concept was
written on. Two plugins cannot share an id, and a near-miss like `task-board`
would be a support problem rather than a solution.

## What it is

A board over the local Tasks database, scoped to one tracker project, with the
six statuses as columns:

| Column | Status |
| --- | --- |
| Backlog | `backlog` |
| Todo | `todo` |
| In progress | `in_progress` |
| In review | `in_review` |
| Done | `done` |
| Canceled | `canceled` |

Done and Canceled are collapsed by default. A board whose right edge is a
growing pile of finished work stops being a board.

## Where the data comes from

This is the one decision the whole plugin rests on, and it is asymmetric:
**read straight from SQLite, write through the CLI.**

### Reading: `~/.bb/plugins/tasks/data.db`, read-only

Verified schema (measured from the working database on 2026-09-19, schema as
shipped with the installed `tasks` plugin):

- `projects(id, name, prefix, color, folder_id, linked_bb_project_id, …)` —
  `linked_bb_project_id` binds a tracker project to a BB project and is
  constrained to `proj_*`. That is the scoping key for a project-first board.
- `tasks(id, project_id, number, title, description, status, priority,
  due_date, parent_task_id, position REAL, created_at, updated_at)` —
  `status` and `priority` are `CHECK`-constrained to exactly the values listed
  above, so the columns cannot drift from the source.
- `labels`, `task_labels` — per-project labels, many-to-many.
- `task_threads(task_id, thread_id, live_status, …)` — attached agent threads
  with a live status of `starting | working | idle | completed | failed`.
- `task_list_revision(id = 1, revision)` — a monotonic counter bumped by
  triggers on insert, update and delete. Revision was 115 when measured.

That last table is the reason reading directly is worth it. Change detection
costs one `SELECT revision` — refetch only when the number moved. Polling the
CLI would mean spawning a process on a timer to learn that nothing happened.

Open the database read-only and treat it as a foreign schema: a `schema_version`
table exists, so read it on startup and refuse to render — with a plain message,
not a crash — if the version is higher than the one the plugin was built
against. Silently misreading someone else's migrated table is worse than saying
nothing.

### Writing: `bb tasks update`, never SQL

Writes go through the CLI even though the file is right there. Writing into
another plugin's database means reimplementing its invariants — the revision
triggers, the `UNIQUE (project_id, number)` numbering, whatever a future
migration adds. The CLI already holds those rules.

```sh
bb tasks update ABC-12 --status in_progress --json
```

## The constraint that shapes the first version

**`bb tasks update` has no `--position` option.** Verified against
`bb tasks update --help`. The flags are status, priority, title, description,
due, parent and labels — nothing that sets manual order.

So moving a card *between* columns is supported, and reordering *within* a
column is not persistable through the supported interface. Two honest options:

- **Phase 1 — no within-column drag.** Cards sort by the `position` the Tasks
  app assigned, and the sort is read-only. Drag across columns changes status;
  drag inside a column is simply not offered, rather than offered and silently
  forgotten on refresh.
- **Phase 2 — only if it proves necessary.** Either write `position` directly
  and bump `task_list_revision` in the same transaction, accepting the coupling
  spelled out above, or propose a `--position` flag upstream. The second is
  slower and correct.

Ship Phase 1. An affordance that quietly discards the user's intent is worse
than a missing one.

## Surfaces

- **App** (`app.tsx`) — the board. Project picker, the six columns, cards with
  title, key, priority, labels and an indicator when a live agent thread is
  attached.
- **Server** (`server.ts`) — an RPC contract in the shape `bb-plugin-aside`
  already uses: reads answered from SQLite, writes shelled out to `bb tasks`.
- **No CLI command.** `bb tasks` already covers the terminal. A second verb for
  the same records would be a maintenance burden with no user.

### Card interactions

Drag between columns, plus a keyboard path for the same move — a board reachable
only by pointer excludes the case where a card is three columns away. Clicking a
card opens the detail with description and comments; the existing Tasks app
handles editing, and a link there is enough.

## What it does not do

- No second data store. Lanes owns no records; every field it shows lives in
  the Tasks database.
- No GitHub, GitLab, Linear or Jira. Remote trackers stay remote — that is the
  premise, not a gap.
- No task creation in the first version. `bb tasks create` and the Tasks app
  both do it, and the board's job is seeing work move.

## Build order

1. Read-only board: open the database, render columns from one project, poll
   `task_list_revision`. Proves the data path before any write exists.
2. Status changes via CLI, with the board reflecting the new revision.
3. Filters — priority, label, attached-thread — and collapsed finished columns.
4. Project picker, remembering the last project per BB project.

Each step is usable on its own; step 1 alone already beats reading a list.

## Testing

Per `AGENTS.md`, every new condition gets a positive **and** a negative test.
The render conditions matter most here, because absence is silence:

- A card with an attached live thread shows the indicator; a card without one
  does not — and the test for the second case must prove the indicator renders
  at all, or it stays green when nothing renders anywhere.
- A schema version higher than the supported one renders the refusal message;
  the supported version renders the board.
- A status the plugin does not know about — impossible today given the `CHECK`
  constraint, possible after a migration — lands somewhere visible rather than
  vanishing from every column.

Fixtures should be a temporary SQLite file built from the real schema, not
hand-written row objects. The schema is the contract with another plugin, and a
mock cannot break when that contract does.

## Open questions for implementation

- Does the Plugin SDK expose a supported way to read another plugin's data
  directory, or is the path constructed from BB's data dir? The concept assumes
  the latter; check before hardcoding.
- Is there an event the host emits on task change that would replace polling the
  revision counter entirely?
- `bb tasks dispatch` hands a task to a new agent thread. Worth surfacing on the
  card, or does that belong to the Tasks app?
