// BBP-14 part 1: integration runs only where the plugin server can reach the
// worktree. Local host → unchanged; remote or unknown host → a clear refusal
// at plan, apply, deliver, merge, rebase and approve, and git is never run.
import { describe, expect, it } from "vitest";
import { runCli } from "../lib/cli";
import { AddressError } from "../lib/delivery";
import { selectBackend, unavailableRemoteGit, createFakeGit, type RemoteGitFactory } from "../lib/integration";
import { FAKE_LOCAL_HOST } from "../lib/thread-port";
import { duoYaml, PROJECT, running, setup } from "./helpers";

const project = async (ref: string | null, ctx: { projectId?: string }) => ref ?? ctx.projectId ?? null;
const ctx = { projectId: PROJECT };
const REMOTE = "host_remote";
const LINE = /integration unavailable on remote host (\S+):/;

function withFile(service: ReturnType<typeof setup>["service"], yaml: string) {
  (service as unknown as { resolveFile: typeof service.resolveFile }).resolveFile = async () => ({ yaml, source: "file", label: "crew.yaml" });
}

const integratorYaml = duoYaml({
  name: "ops",
  checks: "true",
  groups: [{ id: "ops", members: [{ id: "int", lead: true, integrator: true, role: "Merges delivered crew branches into main." }] }],
} as never);

/** A crew whose worktrees live on `host` (null = BB names no host). */
async function crewOn(host: string | null | undefined) {
  const env = setup();
  env.port.projectHost = host;
  const alpha = await running(env.service, env.port, duoYaml({ name: "alpha" }));
  return { ...env, alpha };
}

describe("selectBackend", () => {
  const local = createFakeGit();
  it("local host → the local backend", () => {
    const choice = selectBackend({ hostId: "h1", localHostId: "h1", local, remote: unavailableRemoteGit });
    expect(choice).toEqual({ ok: true, git: local });
  });
  it("another host → the remote backend; the stub says why", () => {
    const choice = selectBackend({ hostId: REMOTE, localHostId: "h1", local, remote: unavailableRemoteGit });
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.reason).toMatch(new RegExp(`^integration unavailable on remote host ${REMOTE}: .*BBP-14`));
  });
  it("another host with a working remote backend → that backend (the seam)", () => {
    const remoteGit = createFakeGit();
    const remote: RemoteGitFactory = (hostId) => (hostId === REMOTE ? { ok: true, git: remoteGit } : unavailableRemoteGit(hostId));
    expect(selectBackend({ hostId: REMOTE, localHostId: "h1", local, remote })).toEqual({ ok: true, git: remoteGit });
    expect(selectBackend({ hostId: "h1", localHostId: "h1", local, remote })).toEqual({ ok: true, git: local });
  });
  it("unknown worktree host → remote with reason", () => {
    const choice = selectBackend({ hostId: null, localHostId: "h1", local, remote: () => ({ ok: true, git: local }) });
    expect(choice).toMatchObject({ ok: false, hostId: null });
    if (!choice.ok) expect(choice.reason).toMatch(/remote host unknown: BB does not name the worktree's host/);
  });
  it("unknown server host → remote with reason, even for a named worktree host", () => {
    const choice = selectBackend({ hostId: "h1", localHostId: null, local, remote: () => ({ ok: true, git: local }) });
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.reason).toMatch(/remote host h1: BB does not name its own host/);
  });
});

describe("local host: unchanged", () => {
  it("plan and apply print no remote line; deliver, approve and rebase run git", async () => {
    const { service, port, git, alpha } = await crewOn(undefined);
    withFile(service, duoYaml({ name: "alpha" }));
    expect(port.localHost).toBe(FAKE_LOCAL_HOST);
    const plan = await runCli(service, ["plan", "crew.yaml"], ctx, project);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("Plan for alpha");
    expect(plan.stdout).not.toMatch(LINE);
    const applied = await runCli(service, ["apply", "crew.yaml"], ctx, project);
    expect(applied.stdout).toContain("alpha: running");
    expect(applied.stdout).not.toMatch(LINE);
    const { merge } = await service.integration.request(alpha.crew, "core-lead@alpha");
    expect((await service.integration.approve(merge.id)).state).toBe("merged");
    expect((await service.integration.rebase(alpha.members["core-dev"]!)).ok).toBe(true);
    expect(git.count("merge")).toBe(1);
    expect(git.count("rebase")).toBe(1);
  });
});

describe("remote host: clear refusal", () => {
  it("plan before the first apply predicts the project's source host", async () => {
    const env = setup();
    env.port.projectHost = REMOTE;
    withFile(env.service, duoYaml({ name: "fresh" }));
    const plan = await runCli(env.service, ["plan", "crew.yaml"], ctx, project);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toMatch(new RegExp(`integration unavailable on remote host ${REMOTE}: .*\\(members: core-lead, core-dev\\)`));
  });

  it("a host: placement on another machine is flagged even when the project is local", async () => {
    const env = setup();
    const yaml = duoYaml({ name: "split", groups: [{ id: "core", members: [{ id: "lead", lead: true, role: "Leads." }, { id: "dev", role: "Builds.", environment: `host:${REMOTE}` }] }] } as never);
    withFile(env.service, yaml);
    const plan = await runCli(env.service, ["plan", "crew.yaml"], ctx, project);
    expect(plan.stdout).toMatch(new RegExp(`remote host ${REMOTE}: .*\\(members: core-dev\\)`));
    expect(plan.stdout).not.toContain("members: core-lead");
  });

  it("plan and apply print the line; git is not asked how far behind the branch is", async () => {
    const { service, git } = await crewOn(REMOTE);
    withFile(service, duoYaml({ name: "alpha" }));
    const plan = await runCli(service, ["plan", "crew.yaml"], ctx, project);
    expect(plan.stdout).toMatch(new RegExp(`remote host ${REMOTE}:`));
    expect(plan.stdout).not.toContain("commit(s) behind");
    const applied = await runCli(service, ["apply", "crew.yaml"], ctx, project);
    expect(applied.stdout).toMatch(new RegExp(`remote host ${REMOTE}:`));
    expect(git.count("behind")).toBe(0);
  });

  it("deliver refuses with the reason and stores no merge request", async () => {
    const { service, store, git, alpha } = await crewOn(REMOTE);
    const attempt = service.integration.request(alpha.crew, "core-lead@alpha");
    await expect(attempt).rejects.toBeInstanceOf(AddressError);
    await expect(service.integration.request(alpha.crew, "core-lead@alpha")).rejects.toThrow(new RegExp(`remote host ${REMOTE}:`));
    expect(store.listMerges({ crewId: alpha.crew.id })).toHaveLength(0);
    expect(git.calls).toHaveLength(0);
  });

  it("rebase refuses with the reason; no merge-conflict need is set", async () => {
    const { service, store, git, alpha } = await crewOn(REMOTE);
    await expect(service.integration.rebase(alpha.members["core-dev"]!)).rejects.toThrow(new RegExp(`remote host ${REMOTE}:`));
    expect(git.count("rebase")).toBe(0);
    expect(store.listNeeds(alpha.members["core-dev"]!.id)).not.toContainEqual(expect.objectContaining({ reason: "merge-conflict" }));
  });

  it("approve and the integrator's merge refuse; the request stays with the human", async () => {
    // A request stored before the host check existed (or by an older plugin version).
    const { service, store, git, alpha } = await crewOn(REMOTE);
    const ops = await running(service, (service as unknown as { ctx: { port: never } }).ctx.port, integratorYaml);
    const merge = store.insertMerge({ id: "mr_old", projectId: PROJECT, crewId: alpha.crew.id, branch: "bb/old", base: "main", requestedBy: "core-lead@alpha" });
    await expect(service.integration.integratorMerge(merge.id, ops.members["ops-int"]!)).rejects.toThrow(new RegExp(`remote host ${REMOTE}:`));
    await expect(service.integration.approve(merge.id)).rejects.toThrow(new RegExp(`remote host ${REMOTE}:`));
    const cli = await runCli(service, ["approve", merge.id], ctx, project);
    expect(cli.exitCode).toBe(1);
    expect(`${cli.stdout ?? ""}${cli.stderr ?? ""}`).toMatch(new RegExp(`remote host ${REMOTE}:`));
    expect(store.getMerge(merge.id)!.state).toBe("open");
    expect(git.count("merge")).toBe(0);
    expect(git.count("checks")).toBe(0);
  });
});

describe("unknown host: treated as remote", () => {
  it("plan names the host unknown; deliver refuses with the reason", async () => {
    const { service, store, alpha } = await crewOn(null);
    withFile(service, duoYaml({ name: "alpha" }));
    const plan = await runCli(service, ["plan", "crew.yaml"], ctx, project);
    expect(plan.stdout).toMatch(/integration unavailable on remote host unknown: BB does not name the worktree's host/);
    await expect(service.integration.request(alpha.crew, "core-lead@alpha")).rejects.toThrow(/remote host unknown/);
    expect(store.listMerges({ crewId: alpha.crew.id })).toHaveLength(0);
  });

  it("BB not naming its own host makes every worktree remote", async () => {
    const env = setup();
    env.port.localHost = null;
    env.port.projectHost = "host_x";
    const alpha = await running(env.service, env.port, duoYaml({ name: "alpha" }));
    await expect(env.service.integration.request(alpha.crew, "core-lead@alpha")).rejects.toThrow(/remote host host_x: BB does not name its own host/);
  });
});

