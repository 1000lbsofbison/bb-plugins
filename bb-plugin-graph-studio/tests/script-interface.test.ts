import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import graphStudio from "../server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function supportedCatalog(providerId = "test-provider", model = "inherited-model") {
  return {
    providers: [{ id: providerId, available: true,
      capabilities: { modelCatalogScope: "host", permissionModes: ["accept-edits", "auto", "full"], supportsServiceTier: true },
      reasoningLevels: [{ id: "high", label: "High" }, { id: "medium", label: "Medium" }],
      serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
    }],
    models: [{ id: model, model, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }, { reasoningEffort: "medium", description: "Medium" }] }],
    selectedOnlyModels: [], modelLoadError: null, permissionCeiling: "full",
  };
}
async function fixture() {
  const host = createFakePluginHost({
    pluginId: "bb-plugin-graph-studio",
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thread-fixture", projectId: "project-fixture", environmentId: "env-fixture" }),
        defaultExecutionOptions: async () => ({ model: "inherited-model", reasoningLevel: "high", serviceTier: "fast", permissionMode: "auto", source: "client/turn/start" }),
      },
      environments: { get: async args => ({ id: args.environmentId, projectId: "project-fixture", hostId: "host-fixture", path: "/independent-task-worktree", status: "ready" }) },
      providers: { models: async () => supportedCatalog() },
      files: { read: async () => ({ content: "frozen assignment\n", contentEncoding: "utf8", path: "/assignment.txt" }) },
    },
  });
  graphStudio(host.bb);
  cleanups.push(() => host.harness.lifecycle.dispose());
  await host.harness.behavior.callRpc("saveGraph", { graph: {
    id: "script-fixture", name: "Script fixture", nodes: [{ id: "result", label: "Result", kind: "note", prompt: "fixture success" }],
    edges: [{ from: "__start__", to: "result" }, { from: "result", to: "__end__" }],
  } });
  return host.harness;
}
const launch = ["run", "script-fixture", "--input-file", "/assignment.txt", "--assignment-id", "attempt-1", "--project", "project-fixture", "--thread", "thread-fixture", "--environment", "env-fixture", "--execution-json", JSON.stringify({ providerId: "test-provider", model: "inherited-model", reasoningLevel: "high", serviceTier: "fast", permissionMode: "auto" }), "--json"];
it("script launch returns structured immutable assignment and status", async () => {
  const harness = await fixture();
  const response = await harness.behavior.runCli(launch);
  expect(response.exitCode).toBe(0);
  const { run } = JSON.parse(response.stdout!);
  expect(run).toMatchObject({ assignmentId: "attempt-1", environmentId: "env-fixture", projectId: "project-fixture", threadId: "thread-fixture", input: "frozen assignment\n" });
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  const status = await harness.behavior.runCli(["status", run.id, "--json"]);
  expect(JSON.parse(status.stdout!).run.id).toBe(run.id);
});
it("an accepted launch with a lost response is recoverable after reload without replacement", async () => {
  let harness = await fixture();
  // Deliberately discard the acceptance response: the caller never persists its id.
  await harness.behavior.runCli(launch);
  const query = ["runs", "--assignment-id", "attempt-1", "--project", "project-fixture", "--json"];
  const first = JSON.parse((await harness.behavior.runCli(query)).stdout!).runs;
  expect(first).toHaveLength(1);
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", first[0].id, "--json"])).stdout!).run.status).toBe("done");
  const replacement = await harness.lifecycle.reload(graphStudio);
  harness = replacement.harness;
  cleanups.push(() => harness.lifecycle.dispose());
  const recovered = JSON.parse((await harness.behavior.runCli(query)).stdout!).runs;
  expect(recovered.map((run: { id: string }) => run.id)).toEqual([first[0].id]);
  const retried = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  expect(retried.id).toBe(first[0].id);
  expect(JSON.parse((await harness.behavior.runCli(query)).stdout!).runs).toHaveLength(1);
});
it("changed immutable launch inputs are rejected and original evidence remains available", async () => {
  const harness = await fixture();
  const first = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", first.id, "--json"])).stdout!).run.status).toBe("done");
  harness.inspection.sdk.stub("files.read", async () => ({ content: "changed assignment", contentEncoding: "utf8", path: "/assignment.txt" }));
  const response = await harness.behavior.runCli(launch);
  expect(response.exitCode).toBe(1);
  expect(JSON.parse(response.stdout!).error.code).toBe("assignment_mismatch");
  const original = JSON.parse((await harness.behavior.runCli(["status", first.id, "--json"])).stdout!).run;
  expect(original.input).toBe("frozen assignment\n");
});
it("unknown options and mismatched execution context fail before acceptance", async () => {
  const harness = await fixture();
  const invalid = await harness.behavior.runCli([...launch, "--nonsense"]);
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(invalid.stdout!).ok).toBe(false);
  const mismatch = launch.map(token => token === "project-fixture" ? "other-project" : token);
  const response = await harness.behavior.runCli(mismatch);
  expect(JSON.parse(response.stdout!).error.code).toBe("execution_context_mismatch");
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--json"])).stdout!).runs).toEqual([]);
});
async function agentFixture(output: string, failure = false) {
  const harness = await fixture();
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-fixture", projectId: "project-fixture", environmentId: "env-fixture" }));
  harness.inspection.sdk.stub("threads.wait", async () => { if (failure) throw new Error("controlled worker failure"); return makeThreadResponse(); });
  harness.inspection.sdk.stub("threads.output", async () => ({ output }));
  harness.inspection.sdk.stub("threads.send", async () => ({}));
  await harness.behavior.callRpc("saveGraph", { graph: {
    id: "script-fixture", name: "Script fixture", nodes: [{ id: "result", label: "Result", kind: "agent", prompt: "Return structured fixture evidence", maxAttempts: 1,
      fields: [{ name: "outcome", type: "enum", options: ["integrated", "blocked"] }, { name: "assignment_id", type: "string" }, { name: "approved_task_sha", type: "string" }, { name: "integrated_feature_sha", type: "string" }, { name: "evidence_refs", type: "list" }] }],
    edges: [{ from: "__start__", to: "result" }, { from: "result", to: "__end__" }],
  } });
  return harness;
}
it("structured success status preserves terminal fields and node evidence", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: ["checks.json"] }));
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  const result = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(result.state.fields.result).toEqual({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: ["checks.json"] });
  expect(result.nodeRuns[0]).toMatchObject({ nodeId: "result", status: "done", childThreadId: "worker-fixture", error: null });
});
it("terminal failure is structured and retained without relaunch on retry", async () => {
  const harness = await agentFixture("", true);
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("failed");
  const result = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(result.error).toContain("controlled worker failure");
  expect(result.nodeRuns[0]).toMatchObject({ status: "failed", error: "controlled worker failure" });
  const retried = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  expect(retried).toMatchObject({ id: run.id, status: "failed", assignmentId: "attempt-1" });
});
it("assignment lookup searches beyond recent runs and concurrent retries return one identity", async () => {
  const harness = await fixture();
  const responses = await Promise.all([harness.behavior.runCli(launch), harness.behavior.runCli(launch)]);
  const original = JSON.parse(responses[0].stdout!).run;
  expect(JSON.parse(responses[1].stdout!).run.id).toBe(original.id);
  const younger = await Promise.all(Array.from({ length: 22 }, (_, n) => harness.behavior.runCli(launch.map(token => token === "attempt-1" ? `later-${n}` : token))));
  const ids = [original.id, ...younger.map(response => JSON.parse(response.stdout!).run.id)];
  await expect.poll(async () => (await Promise.all(ids.map(async id => JSON.parse((await harness.behavior.runCli(["status", id, "--json"])).stdout!).run.status))).every(status => status === "done"), { timeout: 15000 }).toBe(true);
  const found = JSON.parse((await harness.behavior.runCli(["lookup", "--assignment-id", "attempt-1", "--project", "project-fixture", "--json"])).stdout!).runs;
  expect(found.map((run: { id: string }) => run.id)).toEqual([original.id]);
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--assignment-id", "attempt-1", "--project", "other-project", "--json"])).stdout!).runs).toEqual([]);
}, 20000);
it("engine completion exposes a blocked result without relabeling it as integration", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "blocked", assignment_id: "attempt-1", approved_task_sha: "", integrated_feature_sha: "", evidence_refs: ["blocker.json"] }));
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  const result = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(result.state.fields.result).toMatchObject({ outcome: "blocked", integrated_feature_sha: "", evidence_refs: ["blocker.json"] });
});
it("malformed structured worker results retain their contract failure", async () => {
  const harness = await agentFixture("worker omitted the contract");
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("failed");
  const result = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(result.error).toContain("required fields");
  expect(result.nodeRuns[0].status).toBe("failed");
});
it("an empty assignment identity is rejected before launch", async () => {
  const harness = await fixture();
  const response = await harness.behavior.runCli(launch.map(token => token === "attempt-1" ? "" : token));
  expect(response.exitCode).toBe(1);
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--json"])).stdout!).runs).toEqual([]);
});


it("correlated launch freezes complete execution and workers inherit explicit permissions and model", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  expect(run.execution).toEqual({ providerId: "test-provider", model: "inherited-model", reasoningLevel: "high", serviceTier: "fast", permissionMode: "auto" });
  expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ providerId: "test-provider", model: "inherited-model", reasoningLevel: "high", serviceTier: "fast", permissionMode: "auto", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit", permissionMode: "explicit" } });
  harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "different-model", reasoningLevel: "high", serviceTier: "fast", permissionMode: "auto", source: "client/turn/start" }));
  const retried = await harness.behavior.runCli(launch);
  expect(JSON.parse(retried.stdout!).error.code).toBe("execution_context_mismatch");
});
it("explicit node execution overrides inherited model while retaining assigned permissions", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  const { graph } = await harness.behavior.callRpc("getGraph", { id: "script-fixture" });
  Object.assign(graph.nodes[0], { providerId: "node-provider", model: "node-model", reasoningLevel: "medium", serviceTier: "default" });
  await harness.behavior.callRpc("saveGraph", { graph });
  harness.inspection.sdk.stub("providers.models", async () => supportedCatalog("node-provider", "node-model"));
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ providerId: "node-provider", model: "node-model", reasoningLevel: "medium", serviceTier: "default", permissionMode: "auto", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit", permissionMode: "explicit" } });
});


it("expected assignment execution mismatch is rejected before any graph acceptance", async () => {
  const harness = await fixture();
  const response = await harness.behavior.runCli(launch.map((token, index) => launch[index - 1] === "--execution-json" ? JSON.stringify({ providerId: "test-provider", model: "wrong-model", reasoningLevel: "high", serviceTier: "fast", permissionMode: "auto" }) : token));
  expect(JSON.parse(response.stdout!).error.code).toBe("execution_context_mismatch");
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--json"])).stdout!).runs).toEqual([]);
});

function hostLaunch(workspace = "/independent-task-worktree") {
  return launch.filter((_, index) => launch[index] !== "--environment" && launch[index - 1] !== "--environment").concat(["--host", "host-fixture", "--workspace", workspace]);
}
it("an independent host workspace belongs to actual workers and subsequent stages reuse it", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-fixture", environmentId: "independent-env", projectId: "project-fixture" }));
  const { graph } = await harness.behavior.callRpc("getGraph", { id: "script-fixture" });
  graph.nodes.push({ ...graph.nodes[0], id: "after", label: "After" });
  graph.edges = [{ from: "__start__", to: "result" }, { from: "result", to: "after" }, { from: "after", to: "__end__" }];
  await harness.behavior.callRpc("saveGraph", { graph });
  const run = JSON.parse((await harness.behavior.runCli(hostLaunch())).stdout!).run;
  expect(run.environmentRequest).toEqual({ type: "host", hostId: "host-fixture", workspace: { type: "unmanaged", path: "/independent-task-worktree" } });
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  const requests = harness.inspection.sdk.callsTo("threads.spawn").map(call => call[0]);
  expect(requests[0].environment).toEqual(run.environmentRequest);
  expect(requests[1].environment).toEqual({ type: "reuse", environmentId: "independent-env" });
  const result = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(result.environmentId).toBe("independent-env");
  expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});
it("changing an assigned host workspace cannot launch a replacement run", async () => {
  const harness = await fixture();
  const run = JSON.parse((await harness.behavior.runCli(hostLaunch())).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  const response = await harness.behavior.runCli(hostLaunch("/different-worktree"));
  expect(JSON.parse(response.stdout!).error.code).toBe("assignment_mismatch");
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--assignment-id", "attempt-1", "--project", "project-fixture", "--json"])).stdout!).runs.map(run => run.id)).toEqual([run.id]);
});
it("an existing worker environment can differ from the execution context environment", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-fixture", environmentId: "different-worker-env", projectId: "project-fixture" }));
  const run = JSON.parse((await harness.behavior.runCli(launch.map(token => token === "env-fixture" ? "different-worker-env" : token))).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0].environment).toEqual({ type: "reuse", environmentId: "different-worker-env" });
});
it("scripts can read complete context execution without starting a turn", async () => {
  const harness = await fixture();
  const response = await harness.behavior.runCli(["execution", "--thread", "thread-fixture", "--json"]);
  expect(response.exitCode).toBe(0);
  expect(JSON.parse(response.stdout!).execution).toEqual({ providerId: "test-provider", model: "inherited-model", reasoningLevel: "high", serviceTier: "fast", permissionMode: "auto" });
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});
it("an unavailable inherited model on the assigned host is rejected before launch", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  harness.inspection.sdk.stub("providers.models", async () => ({ providers: [{ id: "test-provider", available: true, capabilities: { modelCatalogScope: "host", permissionModes: ["auto"], supportsServiceTier: true } }], models: [], selectedOnlyModels: [], modelLoadError: null, permissionCeiling: "full" }));
  const response = await harness.behavior.runCli(hostLaunch());
  // Drain the old implementation's unexpected acceptance before asserting red.
  if (response.exitCode === 0) {
    const run = JSON.parse(response.stdout!).run;
    await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  }
  expect(response.exitCode).toBe(1);
  expect(JSON.parse(response.stdout!).error.code).toBe("execution_model_unavailable");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--json"])).stdout!).runs).toEqual([]);
});


// Catalogues are external SDK fixtures; launch, persistence, and node dispatch
// below still enter through the registered public CLI and real graph runtime.
const catalogRefusals: Array<[string, string, (catalog: ReturnType<typeof supportedCatalog>) => void]> = [
  ["missing requested provider", "execution_provider_unavailable", catalog => { catalog.providers = []; }],
  ["unavailable requested provider", "execution_provider_unavailable", catalog => { catalog.providers[0].available = false; }],
  ["model offered only by another provider", "execution_provider_unavailable", catalog => { catalog.providers[0].id = "other-provider"; }],
  ["catalog fallback after load error", "execution_catalog_unavailable", catalog => { Object.assign(catalog, { modelLoadError: { code: "timeout", detail: "offline", providerId: "test-provider" } }); }],
  ["unsupported model reasoning", "execution_reasoning_unsupported", catalog => { catalog.models[0].supportedReasoningEfforts = [{ reasoningEffort: "medium", description: "Medium" }]; }],
  ["unsupported fallback provider reasoning", "execution_reasoning_unsupported", catalog => { catalog.models[0].supportedReasoningEfforts = []; catalog.providers[0].reasoningLevels = [{ id: "medium", label: "Medium" }]; }],
  ["undeclared model and provider reasoning", "execution_reasoning_unsupported", catalog => { catalog.models[0].supportedReasoningEfforts = []; catalog.providers[0].reasoningLevels = []; }],
  ["unsupported service tier", "execution_tier_unsupported", catalog => { catalog.providers[0].serviceTiers = [{ id: "default", label: "Default" }]; }],
  ["provider cannot apply requested fast tier", "execution_tier_unsupported", catalog => { catalog.providers[0].capabilities.supportsServiceTier = false; }],
  ["unsupported permission mode", "execution_permission_unsupported", catalog => { catalog.providers[0].capabilities.permissionModes = ["accept-edits"]; }],
  ["requested permission above host ceiling", "execution_permission_ceiling", catalog => { catalog.permissionCeiling = "accept-edits"; }],
  ["workspace catalogue without existing environment", "execution_workspace_catalog_required", catalog => { catalog.providers[0].capabilities.modelCatalogScope = "workspace"; }],
  ["model routes through another provider", "execution_provider_mismatch", catalog => { Object.assign(catalog.models[0], { routeProviderId: "other-provider" }); }],
];
it.each(catalogRefusals)("%s refuses acceptance and worker dispatch", async (_label, code, mutate) => {
  const harness = await agentFixture(JSON.stringify({ outcome: "blocked" }));
  const catalog = supportedCatalog();
  mutate(catalog);
  harness.inspection.sdk.stub("providers.models", async () => catalog);
  const response = await harness.behavior.runCli(hostLaunch());
  expect(response.exitCode).toBe(1);
  expect(JSON.parse(response.stdout!).error.code).toBe(code);
  expect(harness.inspection.sdk.callsTo("providers.models").map(call => call[0])).toEqual([{ hostId: "host-fixture", providerId: "test-provider" }]);
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--json"])).stdout!).runs).toEqual([]);
});
it("an unreadable assigned provider catalog refuses acceptance", async () => {
  const harness = await agentFixture("{}");
  harness.inspection.sdk.stub("providers.models", async () => { throw new Error("host offline"); });
  const response = await harness.behavior.runCli(hostLaunch());
  expect(JSON.parse(response.stdout!).error.code).toBe("execution_catalog_unavailable");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--json"])).stdout!).runs).toEqual([]);
});
it("workspace-scoped and explicitly authorized selected-only models work with an existing environment", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  const catalog = supportedCatalog();
  catalog.providers[0].capabilities.modelCatalogScope = "workspace";
  Object.assign(catalog, { selectedOnlyModels: catalog.models, models: [] });
  harness.inspection.sdk.stub("providers.models", async () => catalog);
  const response = await harness.behavior.runCli(launch);
  expect(response.exitCode).toBe(0);
  const run = JSON.parse(response.stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  expect(harness.inspection.sdk.callsTo("providers.models").every(call => call[0].environmentId === "env-fixture" && call[0].providerId === "test-provider")).toBe(true);
});
it("preflight rejects an unsupported later node override before earlier workers launch", async () => {
  const harness = await agentFixture("{}");
  const { graph } = await harness.behavior.callRpc("getGraph", { id: "script-fixture" });
  graph.nodes.push({ ...graph.nodes[0], id: "after", label: "After", providerId: "node-provider", model: "node-model" });
  graph.edges = [{ from: "__start__", to: "result" }, { from: "result", to: "after" }, { from: "after", to: "__end__" }];
  await harness.behavior.callRpc("saveGraph", { graph });
  harness.inspection.sdk.stub("providers.models", async args => supportedCatalog(args.providerId, args.providerId === "node-provider" ? "wrong-model" : "inherited-model"));
  const response = await harness.behavior.runCli(hostLaunch());
  expect(JSON.parse(response.stdout!).error.code).toBe("execution_model_unavailable");
  expect(harness.inspection.sdk.callsTo("providers.models").map(call => call[0].providerId)).toEqual(["test-provider", "node-provider"]);
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  expect(JSON.parse((await harness.behavior.runCli(["runs", "--json"])).stdout!).runs).toEqual([]);
});
it("recovering an accepted identity does not require its catalog to remain online", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  harness.inspection.sdk.stub("providers.models", async () => { throw new Error("host offline after acceptance"); });
  const retried = await harness.behavior.runCli(launch);
  expect(retried.exitCode).toBe(0);
  expect(JSON.parse(retried.stdout!).run.id).toBe(run.id);
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
it("execution catalog drift before dispatch becomes retained failure without a worker", async () => {
  const harness = await agentFixture("{}");
  let calls = 0;
  harness.inspection.sdk.stub("providers.models", async () => { const catalog = supportedCatalog(); if (++calls > 1) catalog.providers[0].available = false; return catalog; });
  const response = await harness.behavior.runCli(launch);
  expect(response.exitCode).toBe(0);
  const run = JSON.parse(response.stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("failed");
  const status = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(status.error).toContain("unavailable provider");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
});

it.each([true, false])("reasoning uses model declaration when present (%s), otherwise the provider fallback", async modelSpecific => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  const catalog = supportedCatalog();
  if (modelSpecific) {
    // Precise selected-model options supersede the provider's generic ladder.
    catalog.providers[0].reasoningLevels = [{ id: "medium", label: "Medium" }];
  } else {
    // Providers authorize a fallback only when model-specific options are absent.
    catalog.models[0].supportedReasoningEfforts = [];
  }
  harness.inspection.sdk.stub("providers.models", async () => catalog);
  const response = await harness.behavior.runCli(hostLaunch());
  expect(response.exitCode).toBe(0);
  const run = JSON.parse(response.stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
  expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ reasoningLevel: "high", executionInputSources: { reasoningLevel: "explicit" } });
});

it("accepted workers may resolve their environment after the spawn response", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-fixture", projectId: "project-fixture", environmentId: null, status: "starting" }));
  let workerReads = 0;
  harness.inspection.sdk.stub("threads.get", async args => args.threadId === "thread-fixture"
    ? makeThreadResponse({ id: "thread-fixture", projectId: "project-fixture", environmentId: "env-fixture" })
    : makeThreadResponse({ id: "worker-fixture", projectId: "project-fixture", environmentId: ++workerReads > 1 ? "independent-env" : null, status: "starting" }));
  let environmentReads = 0;
  harness.inspection.sdk.stub("environments.get", async args => args.environmentId === "env-fixture"
    ? { id: args.environmentId, projectId: "project-fixture", hostId: "host-fixture", path: "/independent-task-worktree", status: "ready" }
    : { id: args.environmentId, projectId: "project-fixture", hostId: "host-fixture", path: environmentReads++ > 0 ? "/independent-task-worktree" : null, status: environmentReads > 1 ? "ready" : "creating" });
  const response = await harness.behavior.runCli(hostLaunch());
  expect(response.exitCode).toBe(0);
  const run = JSON.parse(response.stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status, { timeout: 10000 }).toBe("done");
  const status = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(status.environmentId).toBe("independent-env");
  expect(status.nodeRuns[0]).toMatchObject({ childThreadId: "worker-fixture", status: "done" });
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
it("environment verification outage retains the accepted child identity", async () => {
  const harness = await agentFixture("{}");
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-fixture", projectId: "project-fixture", environmentId: null, status: "starting" }));
  harness.inspection.sdk.stub("threads.get", async args => {
    if (args.threadId === "thread-fixture") return makeThreadResponse({ id: "thread-fixture", projectId: "project-fixture", environmentId: "env-fixture" });
    throw new Error("controlled readiness outage");
  });
  const run = JSON.parse((await harness.behavior.runCli(hostLaunch())).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status, { timeout: 10000 }).toBe("failed");
  const status = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(status.nodeRuns[0]).toMatchObject({ childThreadId: "worker-fixture", status: "failed" });
  expect(status.error).toContain("controlled readiness outage");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it.each(["stop", "route"])("an accepted environment mismatch bypasses %s retries and retains the worker", async onError => {
  const harness = await agentFixture("{}");
  const { graph } = await harness.behavior.callRpc("getGraph", { id: "script-fixture" });
  Object.assign(graph.nodes[0], { maxAttempts: 3, onError });
  await harness.behavior.callRpc("saveGraph", { graph });
  harness.inspection.sdk.stub("environments.get", async args => ({ id: args.environmentId, projectId: "project-fixture", hostId: "host-fixture", path: "/wrong-task-worktree", status: "ready" }));
  const run = JSON.parse((await harness.behavior.runCli(hostLaunch())).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("failed");
  const status = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(status.nodeRuns).toHaveLength(1);
  expect(status.nodeRuns[0]).toMatchObject({ childThreadId: "worker-fixture", status: "failed" });
  expect(status.error).toContain("does not match the assigned");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  const retry = JSON.parse((await harness.behavior.runCli(hostLaunch())).stdout!).run;
  expect(retry.id).toBe(run.id);
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
it("accepted worker mapping is durable before environment inspection finishes", async () => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-fixture", projectId: "project-fixture", environmentId: "independent-env" }));
  let inspect: (() => void) | undefined;
  harness.inspection.sdk.stub("environments.get", args => args.environmentId === "env-fixture"
    ? Promise.resolve({ id: args.environmentId, projectId: "project-fixture", hostId: "host-fixture", path: "/independent-task-worktree", status: "ready" })
    : new Promise(resolve => {
      inspect = () => resolve({ id: args.environmentId, projectId: "project-fixture", hostId: "host-fixture", path: "/independent-task-worktree", status: "ready" });
    }));
  const run = JSON.parse((await harness.behavior.runCli(hostLaunch())).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.nodeRuns[0]?.childThreadId).toBe("worker-fixture");
  expect(inspect).toBeDefined();
  const pending = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(pending.status).toBe("running");
  expect(pending.environmentId).toBeNull();
  inspect!();
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("done");
});
it("a reused environment mismatch retains the child for recovery", async () => {
  const harness = await agentFixture("{}");
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "worker-fixture", projectId: "project-fixture", environmentId: "wrong-env" }));
  const run = JSON.parse((await harness.behavior.runCli(launch)).stdout!).run;
  await expect.poll(async () => JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status).toBe("failed");
  const status = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(status.nodeRuns[0]).toMatchObject({ childThreadId: "worker-fixture", status: "failed" });
  expect(status.environmentId).toBe("env-fixture");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it.each(["mismatch", "outage"])("dialogue environment %s cannot route into a replacement worker", async failure => {
  const harness = await agentFixture(JSON.stringify({ outcome: "integrated", assignment_id: "attempt-1", approved_task_sha: "task-sha", integrated_feature_sha: "feature-sha", evidence_refs: [] }));
  const { graph } = await harness.behavior.callRpc("getGraph", { id: "script-fixture" });
  const later = { ...graph.nodes[0], id: "after", label: "After" };
  Object.assign(graph.nodes[0], { kind: "dialog", onError: "route", maxAttempts: 3 });
  graph.nodes.push(later);
  graph.edges = [
    { from: "__start__", to: "result" },
    { from: "result", to: "after", when: { source: "output", key: "", op: "failed", value: "" } },
    { from: "result", to: "__end__", when: { source: "output", key: "", op: "succeeded", value: "" } },
    { from: "after", to: "__end__" },
  ];
  await harness.behavior.callRpc("saveGraph", { graph });
  let spawned = 0;
  harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: ++spawned === 1 ? "dialog-worker" : "later-worker", projectId: "project-fixture", environmentId: spawned === 1 ? "dialog-env" : "later-env" }));
  harness.inspection.sdk.stub("environments.get", async args => {
    if (args.environmentId === "dialog-env" && failure === "outage") throw new Error("controlled dialogue environment outage");
    return { id: args.environmentId, projectId: "project-fixture", hostId: "host-fixture", path: args.environmentId === "dialog-env" ? "/wrong-dialog-worktree" : "/independent-task-worktree", status: "ready" };
  });
  const run = JSON.parse((await harness.behavior.runCli(hostLaunch())).stdout!).run;
  await expect.poll(async () => ["failed", "done"].includes(JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run.status)).toBe(true);
  const status = JSON.parse((await harness.behavior.runCli(["status", run.id, "--json"])).stdout!).run;
  expect(status.status).toBe("failed");
  expect(status.nodeRuns).toHaveLength(1);
  expect(status.nodeRuns[0]).toMatchObject({ nodeId: "result", status: "failed", childThreadId: "dialog-worker" });
  expect(status.error).toContain("environment verification failed");
  expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});
