# Working in this repository

Five BB plugins as standalone npm packages, deliberately **without** workspace
tooling on top — they share no dependency.

| Folder | Plugin | State |
| --- | --- | --- |
| `bb-plugin-graph-studio` | `graph-studio` | active development, 660 tests |
| `bb-plugin-crew` | `crew` | persistent agent teams, new, 364 tests |
| `bb-plugin-aside` | `aside` | sidenav replacement, 176 tests |
| `bb-plugin-listen` | `listen` | offline speech in and out, 77 tests |
| `bb-plugin-slim-nav` | `slim-nav` | finished, resting, no tests |

## Where to work

Always **inside a plugin folder**, never at the repository root:

```sh
cd bb-plugin-graph-studio
npx tsc --noEmit
npx vitest run
bb plugin build && bb plugin reload graph-studio
```

The plugins are installed from this repository as `path:` sources and run
straight out of the working tree — after `bb plugin build` a reload is enough,
no reinstall.

## What keeps tripping people up

- `npm install` needs `--include=dev --cache "$TMPDIR/npm-cache"`. The default
  npm cache can hold root-owned files, and `--include=dev` guards against a
  `NODE_ENV=production` left in the environment — without it `vitest` is
  missing.
- `vitest` writes to `node_modules/.vite-temp/` and fails under a sandbox with
  `EPERM`. Run it without the sandbox in that case.
- Graph Studio's database lives **outside** this repository, in
  `~/.bb/plugins/graph-studio/data.db`.
- Tests that load the whole plugin bundle in `beforeAll` need a raised
  `hookTimeout` — the default 10 s is not enough on a cold Vite cache, and the
  run then skips those tests silently instead of failing.

## Conventions

- **English everywhere** — interface, CLI output, templates, prompts, comments
  and identifiers. Comments explain the *why*, not the *what*.
- Every new condition and every new field gets a test for the **negative
  case**. The expensive mistakes here were never crashes; they were rules that
  looked plausible and never fired.
- **And one for the positive case.** A condition with only negative tests is
  unprotected against exactly that mistake: a check that something does *not*
  appear stays green when it appears nowhere at all. This matters most for
  render conditions, where absence is silence rather than an error.
- Templates (`lib/templates.ts`) are code, not database rows. A stored row with
  a template's id would shadow the template, so `resolveGraph` logs a warning
  when it happens.

## Version control

Do not commit, tag, branch or push unless the task asks for it. Change files in
the working tree and describe what changed; committing is a human decision.

This matters most for threads started by a `graph-studio` run. A graph node
sees only its own task, not the state of the working tree — several nodes and a
human work in the **same** working tree, because runs reuse the parent thread's
environment. A commit from inside a node therefore sweeps up other people's
changes, or suggests that a state has been reviewed when nobody looked at it.

Everything read-only is fine: `git status`, `git diff`, `git log`, `git blame`,
`git show`.

## Measure, do not estimate

Numbers about this repository — test counts, line counts, versions — are to be
measured before they are stated. Read them from the working tree, not from the
last commit and not from memory. If you state a number, say where it came from.
