# Lanes

A Kanban board over BB's built-in Tasks. Six status columns for one tracker
project, read from the `tasks` plugin's own database.

Lanes owns no records. Every field it shows lives in the Tasks database, and
every change it makes goes through `bb tasks update`.

## How it reads and writes

Asymmetric on purpose:

- **Reading** — the `tasks` plugin's SQLite file, opened read-only. Its
  `task_list_revision` table is a counter its own triggers bump, so change
  detection costs one `SELECT` instead of a CLI process on a timer.
- **Writing** — `bb tasks update <key> --status <status> --json`. Writing into
  another plugin's database would mean reimplementing its invariants and
  keeping the copy correct forever.

The database path is built from `bb.experimental_dataDir`, never from `~/.bb`:
a dev server keeps its data elsewhere, and a plugin that guesses reads the wrong
one.

## What it does not do

- **No within-column drag.** `bb tasks update` has no `--position` flag
  (measured against bb 0.43.3), so a reorder inside a column cannot be
  persisted through the supported interface. It is not offered rather than
  offered and silently forgotten on refresh. Cards sort by the `position` the
  Tasks app assigned.
- No task creation, no second data store, no remote trackers.

## Development

```sh
npm install --include=dev --cache "$TMPDIR/npm-cache"
npx tsc --noEmit
npx vitest run
bb plugin build && bb plugin reload lanes
```

Test fixtures are a temporary SQLite file built from
`tests/fixtures/tasks-schema.sql`, which is the `.schema` output of the
installed `tasks` plugin's database. The schema is a contract with another
plugin, and a hand-written mock cannot break when that contract does.
