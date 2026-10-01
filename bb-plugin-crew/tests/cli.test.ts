import { describe, expect, it } from "vitest";
import { bound, parseArgs, runCli } from "../lib/cli";
import { duoYaml, PROJECT, running, setup, trioYaml } from "./helpers";

const project = async (ref: string | null, ctx: { projectId?: string }) => ref ?? ctx.projectId ?? null;
const ctx = { projectId: PROJECT };

describe("argument parsing", () => {
  it("collects --fresh values, flags and --project", () => {
    expect(parseArgs(["apply", "trio", "--fresh", "dev-impl", "dev-review", "--confirm-full", "--project", "p9"])).toEqual({
      positional: ["apply", "trio"],
      flags: new Set(["--confirm-full"]),
      project: "p9",
      fresh: ["dev-impl", "dev-review"],
      values: {},
    });
  });
  it("takes values for value options and keeps other flags boolean", () => {
    const parsed = parseArgs(["log", "--crew", "trio", "--status", "rejected", "--cross-crew", "--subject", "Hi there"]);
    expect(parsed.values).toEqual({ crew: "trio", status: "rejected", subject: "Hi there" });
    expect(parsed.flags).toEqual(new Set(["--cross-crew"]));
    expect(parsed.positional).toEqual(["log"]);
  });
  it("bounds long output", () => {
    expect(bound("x".repeat(10), 5)).toContain("truncated (5 more characters)");
    expect(bound("short", 10)).toBe("short");
  });
});

describe("bb crew", () => {
  it("help and templates need no project", async () => {
    const { service } = setup();
    expect((await runCli(service, [], {}, project)).stdout).toContain("bb crew apply");
    expect((await runCli(service, ["templates"], {}, project)).stdout).toMatch(/pair[\s\S]*trio[\s\S]*research/);
  });

  it("negative: no project is a clear error", async () => {
    const { service } = setup();
    const result = await runCli(service, ["list"], {}, project);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--project");
  });

  it("apply a file, then ps, show, export, stop --archive, apply → unarchived", async () => {
    const { service } = setup();
    const readText = async () => trioYaml();
    // Route file reads through the fake.
    (service as unknown as { resolveFile: typeof service.resolveFile }).resolveFile = async () => ({
      yaml: await readText(),
      source: "file",
      label: "crew.yaml",
    });
    const applied = await runCli(service, ["apply", "crew.yaml"], ctx, project);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("trio: running");
    expect(applied.stdout!.match(/spawned/g)).toHaveLength(3);

    const again = await runCli(service, ["apply", "crew.yaml"], ctx, project);
    expect(again.stdout!.match(/reused/g)).toHaveLength(3);

    const ps = await runCli(service, ["ps", "trio"], ctx, project);
    expect(ps.stdout).toContain("orch-lead@trio");
    expect(ps.stdout).toContain("claude-code/claude-haiku-4-5-20251001");
    expect(ps.stdout!.match(/\(BB: claude-code\/claude-haiku-4-5-20251001\)/g)).toHaveLength(3);
    expect(ps.stdout).not.toContain("DRIFT");
    const lead = [...(service.ctx.port as import("../lib/thread-port").FakeThreadPort).threads.values()][0]!;
    lead.model = "other";
    expect((await runCli(service, ["ps", "trio"], ctx, project)).stdout).toContain("DRIFT: BB reports claude-code/other");
    lead.model = "claude-haiku-4-5-20251001";

    expect((await runCli(service, ["show", "trio"], ctx, project)).stdout).toContain("file v1");
    expect((await runCli(service, ["list"], ctx, project)).stdout).toContain("3 members");
    expect((await runCli(service, ["export", "trio"], ctx, project)).stdout).toContain("name: trio");

    const stopped = await runCli(service, ["stop", "trio", "--archive"], ctx, project);
    expect(stopped.stdout!.match(/stopped, archived/g)).toHaveLength(3);
    const back = await runCli(service, ["apply", "crew.yaml"], ctx, project);
    expect(back.stdout!.match(/unarchived/g)).toHaveLength(3);
  });

  it("plan of a template is read-only and lists spawn actions", async () => {
    const { service, port } = setup();
    const result = await runCli(service, ["plan", "pair"], ctx, project);
    expect(result.exitCode).toBe(0);
    expect(result.stdout!.match(/spawn /g)).toHaveLength(2);
    expect(port.countCalls("spawn")).toBe(0);
  });

  it("negative: plan with errors exits 1 and names them", async () => {
    const { service } = setup();
    (service as unknown as { resolveFile: typeof service.resolveFile }).resolveFile = async () => ({
      yaml: trioYaml({ permissions: "full" }),
      source: "file",
      label: "x.yaml",
    });
    const result = await runCli(service, ["plan", "x.yaml"], ctx, project);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--confirm-full");
    expect((await runCli(service, ["plan", "x.yaml", "--confirm-full"], ctx, project)).exitCode).toBe(0);
  });

  it("negative: unknown crew and unknown command", async () => {
    const { service } = setup();
    expect((await runCli(service, ["stop", "ghost"], ctx, project)).stderr).toContain('No crew "ghost"');
    expect((await runCli(service, ["apply", "ghost"], ctx, project)).stderr).toContain('No crew, template or file named "ghost"');
    expect((await runCli(service, ["frobnicate"], ctx, project)).exitCode).toBe(1);
  });
});

describe("resolveFile", () => {
  it("reads paths relative to cwd, stored crews, then templates", async () => {
    const { service } = setup();
    const read: string[] = [];
    const { createCrewService } = await import("../lib/service");
    const svc = createCrewService({
      store: service.ctx.store,
      port: service.ctx.port,
      readText: async (path) => {
        read.push(path);
        return trioYaml();
      },
    });
    expect((await svc.resolveFile(PROJECT, "crew.yaml", "/work")).source).toBe("file");
    expect(read).toEqual(["/work/crew.yaml"]);
    expect((await svc.resolveFile(PROJECT, "trio")).source).toBe("template");
    await svc.apply(PROJECT, trioYaml());
    expect((await svc.resolveFile(PROJECT, "trio")).source).toBe("stored");
  });
});

describe("bb crew messaging commands", () => {
  const run = (service: Parameters<typeof runCli>[0], argv: string[], extra: Record<string, string> = {}) =>
    runCli(service, argv, { ...ctx, ...extra }, project);

  it("log shows an info to the human as info, needs stays empty; negative: a question shows OPEN QUESTION, not INFO (BBP-23)", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", subject: "Status", body: "done", humanKind: "info" });
    expect((await run(service, ["needs"])).stdout).toContain("Nobody needs you");
    const info = (await run(service, ["log", "--crew", "trio"])).stdout;
    expect(info).toContain("dev-impl@trio → human [delivered] info");
    expect(info).toContain("INFO (no answer expected)");
    expect(info).not.toContain("OPEN QUESTION");
    await service.send({ projectId: PROJECT, from: self("dev-review"), to: "human", body: "v1 or v2?" });
    const both = (await run(service, ["log", "--crew", "trio"])).stdout;
    expect(both).toContain("OPEN QUESTION");
    expect(both).not.toContain("dev-review@trio → human [delivered] info");
  });

  it("send as the human answers the open question and shows up in the log with from=human", async () => {
    const { service, port } = setup();
    const { self } = await running(service, port);
    await service.send({ projectId: PROJECT, from: self("dev-impl"), to: "human", body: "v1 or v2?" });
    const needs = await run(service, ["needs"]);
    expect(needs.stdout).toContain("dev-impl@trio");
    expect(needs.stdout).toContain("human-question");
    expect(needs.stdout).toContain("v1 or v2?");
    const sent = await run(service, ["send", "dev-impl@trio", "use", "v2", "--subject", "Answer"]);
    expect(sent.exitCode).toBe(0);
    expect(sent.stdout).toMatch(/dev-impl@trio\s+delivered/);
    expect((await run(service, ["needs"])).stdout).toContain("Nobody needs you");
    const log = await run(service, ["log", "--crew", "trio"]);
    expect(log.stdout).toContain("human → dev-impl@trio [delivered]");
    expect(log.stdout).toContain('"Answer"');
    expect(log.stdout).toContain("answered");
    expect(log.stdout).not.toContain("OPEN QUESTION");
  });

  it("negative: send without text or to an unknown member fails with exit code 1", async () => {
    const { service, port } = setup();
    await running(service, port);
    expect((await run(service, ["send", "dev-impl@trio"])).exitCode).toBe(1);
    const unknown = await run(service, ["send", "dev-ghost@trio", "hi"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('No member "dev-ghost"');
  });

  it("broadcast reaches the crew or one group", async () => {
    const { service, port } = setup();
    await running(service, port);
    const all = await run(service, ["broadcast", "trio", "hello", "all"]);
    expect(all.stdout!.trim().split("\n")).toHaveLength(3);
    const group = await run(service, ["broadcast", "trio", "--group", "dev", "hello", "dev"]);
    expect(group.stdout!.trim().split("\n")).toHaveLength(2);
    expect(group.stdout).not.toContain("orch-lead");
  });

  it("log filters: --cross-crew marks and keeps rejections, --status, --chain, and an unknown status is refused", async () => {
    const { service, port } = setup();
    const a = await running(service, port);
    await running(service, port, duoYaml());
    const [task] = await service.send({ projectId: PROJECT, from: a.self("orch-lead"), to: "dev-review", body: "task" });
    await service.send({ projectId: PROJECT, from: a.self("dev-impl"), to: "core-lead@duo", body: "cross" });
    const cross = await run(service, ["log", "--cross-crew"]);
    expect(cross.stdout).toContain("CROSS-CREW trio → duo");
    expect(cross.stdout).toContain("[rejected]");
    expect(cross.stdout).toContain("reason: crossCrew: leads");
    expect(cross.stdout).not.toContain('"task"');
    expect((await run(service, ["log", "--status", "rejected"])).stdout).not.toContain('"task"');
    expect((await run(service, ["log", "--chain", task!.chainId])).stdout).toContain('"task"');
    expect((await run(service, ["log", "--chain", task!.chainId])).stdout).not.toContain("cross");
    expect((await run(service, ["log", "--status", "lost"])).exitCode).toBe(1);
    expect((await run(service, ["log", "--full"])).stdout).toContain("  | task");
  });

  it("whoami works inside a member thread only", async () => {
    const { service, port } = setup();
    const { threads } = await running(service, port);
    const inside = await run(service, ["whoami"], { threadId: threads["orch-lead"]! });
    expect(inside.stdout).toContain("orch-lead@trio  lead");
    expect(inside.stdout).toContain("crew trio");
    const outside = await run(service, ["whoami"], { threadId: "th_other" });
    expect(outside.exitCode).toBe(1);
  });

  it("release, discard and stop-chain act on held messages", async () => {
    const { service, port, store } = setup();
    const { self, threads } = await running(service, port);
    port.threads.get(threads["dev-impl"]!)!.interactions.push({ id: "i", kind: "approval", title: "?" });
    const [held] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "a" });
    const [other] = await service.send({ projectId: PROJECT, from: self("orch-lead"), to: "dev-impl", body: "b" });
    expect((await run(service, ["release", held!.id])).stdout).toMatch(/delivered|queued/);
    expect((await run(service, ["discard", other!.id])).stdout).toContain("discarded by the human");
    expect((await run(service, ["discard", other!.id])).exitCode).toBe(1);
    const stopped = await run(service, ["stop-chain", held!.chainId]);
    expect(stopped.stdout).toContain(`chain ${held!.chainId} stopped`);
    expect(store.chainStop(held!.chainId)).not.toBeNull();
  });
});

describe("bb crew (E3)", () => {
  it("work: create, list, claim --as, done; unknown sub-command and bad tier are refused", async () => {
    const { service, port } = setup();
    await running(service, port);
    const created = await runCli(service, ["work", "create", "Write", "docs", "--owner", "dev-impl", "--tier", "p1"], ctx, project);
    expect(created.stdout).toMatch(/wi_1 \[open\] p1 "Write docs" owner dev-impl@trio/);
    expect((await runCli(service, ["work", "claim", "wi_1", "--as", "dev-impl"], ctx, project)).stdout).toContain("[claimed]");
    expect((await runCli(service, ["work"], ctx, project)).stdout).toContain("wi_1");
    expect((await runCli(service, ["work", "done", "wi_1", "shipped"], ctx, project)).stdout).toContain("[done]");
    expect((await runCli(service, ["work", "list"], ctx, project)).stdout).toContain("No work items.");
    expect((await runCli(service, ["work", "frob"], ctx, project)).exitCode).toBe(1);
    expect((await runCli(service, ["work", "create", "x", "--tier", "p7"], ctx, project)).exitCode).toBe(1);
  });

  it("channel: post as the human, read back; merges/approve/reject; directory; deps; thread-limit; tick", async () => {
    const { service, port, git } = setup();
    await running(service, port, duoYaml({ name: "alpha", task: "CRD-1" }));
    await running(service, port, duoYaml({ name: "beta", waitsFor: [{ task: "CRD-1", until: "merged" }] }));
    expect((await runCli(service, ["channel", "alpha", "post", "hello", "@core-dev", "--topic", "t"], ctx, project)).stdout).toContain("mention → core-dev@alpha");
    expect((await runCli(service, ["channel", "alpha"], ctx, project)).stdout).toContain("human [t]: hello @core-dev");
    const alpha = service.findCrew(PROJECT, "alpha")!;
    const { merge } = await service.integration.request(alpha, "core-lead@alpha");
    expect((await runCli(service, ["merges"], ctx, project)).stdout).toContain(`${merge.id} [open] alpha`);
    git.mergeResult = { ok: false, conflict: true, detail: "CONFLICT" };
    const conflict = await runCli(service, ["approve", merge.id], ctx, project);
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stdout).toContain("[returned]");
    git.mergeResult = { ok: true, commit: "c0ffee" };
    expect((await runCli(service, ["approve", merge.id], ctx, project)).stdout).toContain("[merged]");
    expect((await runCli(service, ["reject", merge.id], ctx, project)).exitCode).toBe(1);
    expect((await runCli(service, ["approve", "mr_nope"], ctx, project)).exitCode).toBe(1);
    expect((await runCli(service, ["directory"], ctx, project)).stdout).toMatch(/alpha · running · task CRD-1[\s\S]*beta/);
    expect((await runCli(service, ["deps"], ctx, project)).stdout).toContain("beta             waits for CRD-1 until merged: satisfied");
    expect((await runCli(service, ["thread-limit"], ctx, project)).stdout).toContain("not readable");
    expect((await runCli(service, ["thread-limit", "3"], ctx, project)).stdout).toContain("Thread limit: 3 (plugin-side");
    expect((await runCli(service, ["thread-limit", "x"], ctx, project)).exitCode).toBe(1);
    expect((await runCli(service, ["thread-limit", "off"], ctx, project)).stdout).toContain("not readable");
    expect((await runCli(service, ["tick"], ctx, project)).stdout).toContain("0 follow-up(s), 0 dependencies fulfilled");
  });

  it("plan prints the thread line and how far the branch is behind main", async () => {
    const { service, port, git } = setup();
    await running(service, port);
    git.behindCount = 2;
    const out = (await runCli(service, ["plan", "trio"], ctx, project)).stdout!;
    expect(out).toContain("Threads: 3 members in running crews");
    expect(out).toContain("2 commit(s) behind main");
  });
});

describe("bb crew — E4 lifecycle commands", () => {
  const run = (service: ReturnType<typeof setup>["service"], argv: string[]) => runCli(service, argv, ctx, project);

  it("snapshot, snapshots, restore", async () => {
    const { service, port } = setup();
    await running(service, port);
    const snap = await run(service, ["snapshot", "trio", "--label", "base"]);
    expect(snap.exitCode).toBe(0);
    const id = /snapshot (snap_\d+)/.exec(snap.stdout!)![1]!;
    expect(snap.stdout).toContain("3 binding(s), 0 open work item(s), 0 undelivered message(s)");
    expect((await run(service, ["snapshots", "trio"])).stdout).toContain(`${id}`);
    await run(service, ["stop", "trio", "--archive"]);
    const restored = await run(service, ["restore", id]);
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toMatch(/binding\s+orch-lead\s+th_1\s+shift 1\s+same/);
    expect(restored.stdout).toMatch(/unarchived\s+dev-impl@trio/);
    expect((await run(service, ["restore", "snap_nope"])).exitCode).toBe(1);
  });

  it("reset, handover with --brief, add-member, remove-member", async () => {
    const { service, port } = setup();
    await running(service, port);
    expect((await run(service, ["reset", "dev-impl@trio"])).stdout).toMatch(/updated\s+dev-impl@trio\s+th_2\s+shift 2/);
    expect((await run(service, ["reset", "dev-impl", "--mode", "sideways"])).exitCode).toBe(1);
    const handover = await run(service, ["handover", "dev-review@trio", "--brief", "Nothing open."]);
    expect(handover.stdout).toMatch(/handover ho_\d+: done, brief as work item wi_\d+/);
    expect(handover.stdout).toMatch(/spawned\s+dev-review@trio\s+th_4\s+shift 2/);
    expect((await run(service, ["add-member", "dev-docs", "--role", "Docs."])).stdout).toMatch(/spawned\s+dev-docs@trio/);
    expect((await run(service, ["remove-member", "dev-docs@trio"])).stdout).toMatch(/removed\s+dev-docs@trio/);
    expect((await run(service, ["remove-member", "orch-lead"])).exitCode).toBe(1);
  });

  it("attach lists candidates without arguments and binds with --as", async () => {
    const { service, port } = setup();
    await running(service, port);
    port.addForeign({ id: "thr_x", projectId: PROJECT, title: "scratch" });
    expect((await run(service, ["attach"])).stdout).toContain("thr_x");
    await run(service, ["detach", "dev-review@trio"]);
    const attached = await run(service, ["attach", "thr_x", "--as", "dev-review@trio"]);
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain("attached thr_x as dev-review@trio (shift 2); no new thread, no restart");
    expect(attached.stdout).toMatch(/kickoff brief: msg msg_\d+ delivered/);
    expect((await run(service, ["attach", "thr_x", "--as", "dev-impl@trio"])).stderr).toContain("already bound");
  });

  it("export → import: unchanged file, plan no change; the plan lines equal bb crew plan's", async () => {
    const { service, port } = setup();
    await running(service, port);
    const exported = (await run(service, ["export", "trio"])).stdout!;
    const files = new Map([["/w/crew.yaml", exported]]);
    // Same service, with a file reader that knows the exported file.
    const svc = Object.assign(Object.create(Object.getPrototypeOf(service)), service, {
      resolveFile: async (projectId: string, ref: string, cwd?: string) =>
        files.has(ref) ? { yaml: files.get(ref)!, source: "file" as const, label: ref } : service.resolveFile(projectId, ref, cwd),
    });
    const imported = await runCli(svc, ["import", "/w/crew.yaml"], ctx, project);
    expect(imported.stdout).toContain("imported trio: file v1 (unchanged, same file)");
    expect(imported.stdout).toContain("plan: no change");
    const plan = await run(service, ["plan", "trio"]);
    const planLines = plan.stdout!.split("\n").filter((line) => /^\s+reuse /.test(line));
    expect(planLines).toHaveLength(3);
    for (const line of planLines) expect(imported.stdout).toContain(line);
  });
});
