// https://github.com/1000lbsofbison/Orchestration/issues/2
// Scripted workers at the existing RuntimeHost seam; real runtime, fields,
// routing, store, and SQLite checkpoints. No provider, server or network.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import happyFile from "./fixtures/orchestration/fixture-github-review.graph.json";
import revisionFile from "./fixtures/orchestration/fixture-github-revision.graph.json";
import { emptyRunState, graphSchema, validateGraph, type Graph, type RunState } from "../lib/graph";
import { compileGraph, type RuntimeHost } from "../lib/runtime";
import { SqliteCheckpointer } from "../lib/checkpointer";
import { createStore, MIGRATIONS, type Store } from "../lib/store";

const initialSha = "a".repeat(40);
const revisedSha = "b".repeat(40);
const feedback = `smoke-revision-feedback:scripted: remove injected comment at ${initialSha}`;
const assignment = JSON.stringify({ run_id: "scripted", issue_url: "https://github.com/1000lbsofbison/orchestration-fixtures/issues/1", assignment_sha256: "frozen" });
const ready = (sha = initialSha) => JSON.stringify({ status: "READY FOR REVIEW", candidate_sha: sha, blockers: "", notes: "validated", validation_evidence: ["/fixture/implementor.json"] });
const review = (verdict: string, sha = initialSha) => JSON.stringify({ verdict, final_task_sha: sha, approved_sha: verdict === "APPROVED" ? sha : "", findings: verdict === "CHANGES REQUIRED" ? feedback : "Standards pass; Spec pass", blockers: "", validation_evidence: ["/fixture/reviewer.json"], assignment_sha256: "frozen" });
type Reply = string | Error;
type Script = Record<string, Reply[]>;

const resources: Array<{ db: Database.Database; directory: string }> = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), "orchestration-routing-"));
  const path = join(directory, "run.sqlite");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  const resource = { db, directory };
  resources.push(resource);
  return { resource, path, db, store: createStore(db) };
}
function scriptedHost(store: Store, scripts: Script) {
  const prompts: Array<{ nodeId: string; prompt: string }> = [];
  const replies = new Map<string, Reply>();
  const counters: Record<string, number> = {};
  const waits: number[] = [];
  const logs: string[] = [];
  const host: RuntimeHost = {
    async spawn({ nodeId, prompt }) {
      prompts.push({ nodeId, prompt });
      const index = counters[nodeId] ?? 0;
      counters[nodeId] = index + 1;
      const reply = scripts[nodeId]?.[index];
      if (reply === undefined) throw new Error(`Unexpected worker ${nodeId} visit ${index + 1}`);
      const threadId = `thr_${nodeId}_${store.countAttempts("scripted", nodeId)}`;
      replies.set(threadId, reply);
      return threadId;
    },
    async awaitThread(threadId) {
      const reply = replies.get(threadId)!;
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async sendMessage() { throw new Error("No dialog workers in fixture"); },
    async loadDialog() { return null; },
    async saveDialog() { throw new Error("No dialog workers in fixture"); },
    async onNodeStart(nodeId) {
      const attempt = store.countAttempts("scripted", nodeId) + 1;
      const id = `${nodeId}_${attempt}`;
      store.insertNodeRun({ id, runId: "scripted", nodeId, attempt, status: "running", childThreadId: null,
        output: null, error: null, startedAt: 1, endedAt: null, inputTokens: null, outputTokens: null });
      return id;
    },
    async onNodeThread(id, threadId) { store.attachThread(id, threadId); },
    async onNodeFinish(id, patch) { store.updateNodeRun(id, { ...patch, endedAt: 2 }); },
    async onStateChange(state) { store.updateRun("scripted", { status: "running", state, error: null }, 2); },
    async wait(ms) { waits.push(ms); },
    log(message) { logs.push(message); },
  };
  return { host, prompts, waits, logs };
}
function setup(graph: Graph, scripts: Script) {
  const db = database();
  db.store.insertRun({ id: "scripted", graphId: graph.id, graph, threadId: "context", projectId: "fixtures",
    assignmentId: "scripted", input: assignment, state: emptyRunState(assignment), status: "running", error: null, createdAt: 1, updatedAt: 1 });
  const scripted = scriptedHost(db.store, scripts);
  const app = compileGraph(graph, scripted.host, new SqliteCheckpointer(db.db));
  const config = { configurable: { thread_id: "scripted" }, recursionLimit: 50 };
  return { ...db, ...scripted, app, config };
}
const graphs = [happyFile, revisionFile].map(file => graphSchema.parse(file.graph));

describe.each(graphs)("versioned $id at the real runner boundary", graph => {
  it("validates and approves the exact first candidate with independent workers", async () => {
    expect(validateGraph(graph).filter(problem => problem.level === "error")).toEqual([]);
    const t = setup(graph, { implementor: [ready()], reviewer: [review("APPROVED")] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts.map(p => p.nodeId)).toEqual(["implementor", "reviewer"]);
    expect(t.prompts[1]!.prompt).toContain(initialSha);
    expect(out.fields.reviewer?.approved_sha).toBe(initialSha);
    expect(out.fields.implementor?.validation_evidence).toEqual(["/fixture/implementor.json"]);
    const rows = t.store.listNodeRuns("scripted");
    expect(rows.map(row => row.status)).toEqual(["done", "done"]);
    expect(rows[0]!.childThreadId).not.toBe(rows[1]!.childThreadId);
    expect(t.store.getRun("scripted")?.state).toEqual(out);
  });

  it("delivers fixed rejection to the revision worker and reviews the revised SHA", async () => {
    const t = setup(graph, { implementor: [ready(), ready(revisedSha)], reviewer: [review("CHANGES REQUIRED"), review("APPROVED", revisedSha)] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts.map(p => p.nodeId)).toEqual(["implementor", "reviewer", "implementor", "reviewer"]);
    expect(t.prompts[2]!.prompt).toContain(feedback);
    expect(t.prompts[2]!.prompt).toContain(initialSha);
    expect(t.prompts[3]!.prompt).toContain(revisedSha);
    expect(out.fields.reviewer?.approved_sha).toBe(revisedSha);
    expect(out.visits).toEqual({ implementor: 2, reviewer: 2 });
    expect(t.store.listNodeRuns("scripted").map(row => row.status)).toEqual(["done", "done", "done", "done"]);
  });

  it.each(["not JSON", JSON.stringify({ status: "invented enum" })])("routes invalid implementation output to end without review (%s)", async output => {
    const t = setup(graph, { implementor: [output] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts.map(p => p.nodeId)).toEqual(["implementor"]);
    expect(out.errors.implementor).toBeTruthy();
    expect(out.fields.reviewer).toBeUndefined();
    expect(t.store.listNodeRuns("scripted")[0]?.status).toBe("failed");
    expect(t.store.listNodeRuns("scripted")[0]?.error).toBeTruthy();
  });

  it("routes malformed reviewer output to end without approval", async () => {
    const t = setup(graph, { implementor: [ready()], reviewer: ["not JSON"] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts.map(p => p.nodeId)).toEqual(["implementor", "reviewer"]);
    expect(out.errors.reviewer).toBeTruthy();
    expect(out.fields.reviewer).toBeUndefined();
    expect(t.store.listNodeRuns("scripted")[1]?.status).toBe("failed");
  });

  it("recovers a failed attempt under an explicitly test-only retry policy", async () => {
    const retryGraph = graphSchema.parse({ ...graph, nodes: graph.nodes.map(node => node.id === "implementor" ? { ...node, maxAttempts: 2 } : node) });
    const t = setup(retryGraph, { implementor: [new Error("transient failure"), ready()], reviewer: [review("APPROVED")] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts.map(p => p.nodeId)).toEqual(["implementor", "implementor", "reviewer"]);
    expect(t.waits).toHaveLength(1);
    expect(out.errors.implementor).toBe("");
    expect(out.fields.reviewer?.approved_sha).toBe(initialSha);
    expect(t.store.listNodeRuns("scripted").map(row => row.status)).toEqual(["failed", "done", "done"]);
  });

  it("ends blocked review without approving or revisiting", async () => {
    const t = setup(graph, { implementor: [ready()], reviewer: [review("BLOCKED")] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts.map(p => p.nodeId)).toEqual(["implementor", "reviewer"]);
    expect(out.fields.reviewer?.approved_sha).toBe("");
  });

  it("bounds repeated rejection at three visits and keeps unapproved state", async () => {
    const t = setup(graph, { implementor: [ready(), ready(), ready()], reviewer: [review("CHANGES REQUIRED"), review("CHANGES REQUIRED"), review("CHANGES REQUIRED")] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts).toHaveLength(6);
    expect(out.visits).toEqual({ implementor: 3, reviewer: 3 });
    expect(out.fields.reviewer?.verdict).toBe("CHANGES REQUIRED");
    expect(t.logs.some(log => log.includes("visit"))).toBe(true);
  });

  it("persists a worker timeout and takes the failure exit at the one-attempt production policy", async () => {
    const t = setup(graph, { implementor: [new Error("Worker timed out")] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts).toHaveLength(1);
    expect(out.errors.implementor).toContain("timed out");
    const row = t.store.listNodeRuns("scripted")[0]!;
    expect(row.status).toBe("failed");
    expect(row.childThreadId).toBeTruthy();
    expect(row.error).toContain("timed out");
  });

  it("exhausts an explicitly test-only three-attempt policy before the same failure exit", async () => {
    const retryGraph = graphSchema.parse({ ...graph, nodes: graph.nodes.map(node => node.id === "implementor" ? { ...node, maxAttempts: 3 } : node) });
    const t = setup(retryGraph, { implementor: [new Error("retry 1"), new Error("retry 2"), new Error("retry 3")] });
    const out = await t.app.invoke(emptyRunState(assignment), t.config) as RunState;
    expect(t.prompts).toHaveLength(3);
    expect(t.waits).toHaveLength(2);
    expect(out.errors.implementor).toBe("retry 3");
    expect(t.store.listNodeRuns("scripted").map(row => [row.attempt, row.status])).toEqual([[1, "failed"], [2, "failed"], [3, "failed"]]);
  });

  it("recovers rejection from reopened SQLite without repeating initial workers", async () => {
    const t = setup(graph, { implementor: [ready()], reviewer: [review("CHANGES REQUIRED")] });
    await t.app.invoke(emptyRunState(assignment), { ...t.config, interruptAfter: ["reviewer"] });
    expect(t.prompts.map(p => p.nodeId)).toEqual(["implementor", "reviewer"]);
    const before = t.store.listNodeRuns("scripted").map(row => row.id);
    t.db.close();
    const reopened = new Database(t.path);
    reopened.pragma("synchronous = NORMAL");
    t.resource.db = reopened;
    const store = createStore(reopened);
    const recovered = scriptedHost(store, { implementor: [ready(revisedSha)], reviewer: [review("APPROVED", revisedSha)] });
    const app = compileGraph(graph, recovered.host, new SqliteCheckpointer(reopened));
    const checkpoint = await app.getState(t.config);
    expect(checkpoint.next).toEqual(["implementor"]);
    const out = await app.invoke(null, t.config) as RunState;
    expect(recovered.prompts.map(p => p.nodeId)).toEqual(["implementor", "reviewer"]);
    expect(recovered.prompts[0]!.prompt).toContain(feedback);
    expect(out.fields.reviewer?.approved_sha).toBe(revisedSha);
    expect(store.listNodeRuns("scripted").slice(0, 2).map(row => row.id)).toEqual(before);
    expect(store.listNodeRuns("scripted")).toHaveLength(4);
    expect(store.findAssignment("fixtures", "scripted")?.id).toBe("scripted");
  });
});
