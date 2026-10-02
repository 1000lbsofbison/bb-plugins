# Orchestration fixture snapshots

Canonical source: https://github.com/1000lbsofbison/Orchestration/issues/2
and that repository's `graphs/*.graph.json` at the issue-2-routing revision.

These are byte-for-byte snapshots, not copies of runner code. The Orchestration
`smoke.routing_tests` bridge checks both against its canonical graph files before
running `tests/orchestration-routing.test.ts` in this owning plugin package.
Resync snapshots intentionally when canonical definitions change.

Both share the implementation/review edges and six-step cap of the inventoried
`necro-task-cycle-finalizer-44` production graph. Prompts, assignment and evidence
contracts are fixture-specific. `fixture-github-revision` adds explicitly labeled
live comment-defect injection to prompts only; it does not change the routing.
These tests cover the shared routing pattern, not Necro product prompts/helpers,
GitHub policy, real provider timing or the product parent workflow.

The suite replaces only RuntimeHost worker replies (including simulated timeout
errors) and retry backoff. `compileGraph`, field parsing, routing, node records,
store, SQLite checkpointer and reopen/resume remain real. File-backed SQLite uses
WAL and test-local synchronous=NORMAL. The retry success/exhaustion cases change
maxAttempts to 2/3 in explicitly named test-only variants; live graphs keep one
attempt per visit. Three-visit rejection limits and checkpoint recovery use the
unchanged graph. Scripted replies are not exported in a CLI, setting, server route
or provider protocol. No runner implementation change or live result tool added.

The owning checkout records an earlier installed boundary baseline separately
from the issue #2 test commit. Those prior changes belong to Necro issue #18;
the issue #2 diff adds only this suite and graph snapshots.
