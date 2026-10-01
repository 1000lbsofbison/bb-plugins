import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  createSdkThreadPort,
  isWorkspaceBusy,
  permissionModeFor,
  whileWorkspaceBusy,
  type SpawnRequest,
} from "../lib/thread-port";

const busy = () => Object.assign(new Error("busy"), { status: 409, code: "workspace_busy" });

const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  projectId: "p1",
  prompt: "hello",
  title: "dev-impl@trio",
  providerId: "claude-code",
  model: "claude-haiku-4-5-20251001",
  permissions: "accept-edits",
  parentThreadId: "th_lead",
  environment: { kind: "managed-worktree" },
  metadata: { crew: "trio", crewId: "c", member: "dev-impl", address: "dev-impl@trio", shift: 1, opId: "op1", lead: false },
  ...overrides,
});

describe("workspace_busy backoff", () => {
  it("positive: recognises 409 workspace_busy", () => expect(isWorkspaceBusy(busy())).toBe(true));
  it("negative: other 409s and plain errors are not busy", () => {
    expect(isWorkspaceBusy(Object.assign(new Error(), { status: 409, code: "conflict" }))).toBe(false);
    expect(isWorkspaceBusy(new Error("workspace_busy"))).toBe(false);
  });
  it("retries while busy, then returns", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await whileWorkspaceBusy(
      async () => {
        calls += 1;
        if (calls < 3) throw busy();
        return "ok";
      },
      { sleep: async (ms) => void sleeps.push(ms), now: () => 0 },
    );
    expect(result).toBe("ok");
    expect(sleeps).toEqual([250, 500]);
  });
  it("rethrows other errors at once", async () => {
    let calls = 0;
    await expect(
      whileWorkspaceBusy(async () => {
        calls += 1;
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
  it("gives up after the timeout", async () => {
    let time = 0;
    await expect(
      whileWorkspaceBusy(async () => {
        throw busy();
      }, { timeoutMs: 1000, sleep: async (ms) => void (time += ms), now: () => time }),
    ).rejects.toMatchObject({ code: "workspace_busy" });
  });
});

describe("permission mapping", () => {
  it("ask maps to accept-edits (BB has no read-only mode)", () => expect(permissionModeFor("ask")).toBe("accept-edits"));
  it.each(["accept-edits", "auto", "full"] as const)("%s passes through", (mode) => expect(permissionModeFor(mode)).toBe(mode));
});

describe("SDK thread port", () => {
  it("spawns with explicit execution sources, metadata seed, visible, managed worktree", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "crew",
      sdk: {
        threads: { spawn: async () => makeThreadResponse({ id: "th_new", providerId: "claude-code" }) },
        projects: {
          get: async () =>
            ({ sources: [{ hostId: "host_other", isDefault: false }, { hostId: "host_1", isDefault: true }] }) as never,
        },
      },
    });
    const port = createSdkThreadPort(bb);
    const thread = await port.spawn(request());
    expect(thread.id).toBe("th_new");
    const [call] = harness.inspection.sdk.callsTo("threads.spawn");
    expect(call![0]).toMatchObject({
      projectId: "p1",
      title: "dev-impl@trio",
      visibility: "visible",
      providerId: "claude-code",
      model: "claude-haiku-4-5-20251001",
      permissionMode: "accept-edits",
      executionInputSources: { providerId: "explicit", model: "explicit", permissionMode: "explicit" },
      parentThreadId: "th_lead",
      environment: { type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      pluginMetadata: { opId: "op1", address: "dev-impl@trio" },
    });
  });

  it("passes reasoning level and service tier as explicit choices; negative: absent ones are not sent", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "crew",
      sdk: { threads: { spawn: async () => makeThreadResponse({ id: "th_r" }) } },
    });
    const port = createSdkThreadPort(bb);
    await port.spawn(request({ parentThreadId: null, environment: { kind: "reuse", environmentId: "env_1" }, reasoningLevel: "high", serviceTier: "fast" }));
    await port.spawn(request({ parentThreadId: null, environment: { kind: "reuse", environmentId: "env_1" } }));
    const [withChoice, without] = harness.inspection.sdk.callsTo("threads.spawn").map((call) => call[0] as Record<string, unknown>);
    expect(withChoice).toMatchObject({
      reasoningLevel: "high",
      serviceTier: "fast",
      executionInputSources: { reasoningLevel: "explicit", serviceTier: "explicit" },
    });
    expect("reasoningLevel" in without!).toBe(false);
    expect("serviceTier" in without!).toBe(false);
    expect(without!.executionInputSources).toEqual({ providerId: "explicit", model: "explicit", permissionMode: "explicit" });
  });

  it("maps reuse and omits parentThreadId for the lead", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "crew",
      sdk: { threads: { spawn: async () => makeThreadResponse({ id: "th_l" }) } },
    });
    await createSdkThreadPort(bb).spawn(request({ parentThreadId: null, environment: { kind: "reuse", environmentId: "env_1" } }));
    const args = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(args.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect("parentThreadId" in args).toBe(false);
  });

  it("retries a busy spawn", async () => {
    let calls = 0;
    const { bb } = createFakePluginHost({
      pluginId: "crew",
      sdk: {
        threads: {
          spawn: async () => {
            calls += 1;
            if (calls === 1) throw busy();
            return makeThreadResponse({ id: "th_2" });
          },
        },
        projects: { get: async () => ({ sources: [{ hostId: "h", isDefault: true }] }) as never },
      },
    });
    const port = createSdkThreadPort(bb, { backoff: { sleep: async () => undefined } });
    expect((await port.spawn(request())).id).toBe("th_2");
    expect(calls).toBe(2);
  });

  it("get: 404 and deleted threads are null, archived is flagged", async () => {
    const { bb } = createFakePluginHost({
      pluginId: "crew",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "gone") throw Object.assign(new Error("not found"), { status: 404 });
            if (threadId === "deleted") return makeThreadResponse({ id: threadId, deletedAt: 5 });
            return makeThreadResponse({ id: threadId, archivedAt: 7 });
          },
        },
      },
    });
    const port = createSdkThreadPort(bb);
    expect(await port.get("gone")).toBeNull();
    expect(await port.get("deleted")).toBeNull();
    expect((await port.get("a"))!.archived).toBe(true);
  });

  it("model comes from defaultExecutionOptions, null when BB has none", async () => {
    const { bb } = createFakePluginHost({
      pluginId: "crew",
      sdk: {
        threads: {
          defaultExecutionOptions: async ({ threadId }: { threadId: string }) =>
            threadId === "none" ? null : ({ model: "claude-haiku-4-5-20251001" } as never),
        },
      },
    });
    const port = createSdkThreadPort(bb);
    expect(await port.model("t")).toBe("claude-haiku-4-5-20251001");
    expect(await port.model("none")).toBeNull();
  });

  it("listOwn asks for own, hidden, archived and active threads", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "crew",
      sdk: { threads: { list: async () => [] } },
    });
    await createSdkThreadPort(bb).listOwn("p1");
    const calls = harness.inspection.sdk.callsTo("threads.list").map((c) => c[0]);
    expect(calls).toEqual([
      expect.objectContaining({ projectId: "p1", originPluginId: "crew", includeHidden: true, archived: false }),
      expect.objectContaining({ archived: true }),
    ]);
  });
});

describe("interaction titles", () => {
  it("uses title, then question prompts, then reason, then the kind", async () => {
    const { interactionTitle } = await import("../lib/thread-port");
    expect(interactionTitle({ kind: "plugin", title: "Confirm full" })).toBe("Confirm full");
    expect(interactionTitle({ kind: "user_question", questions: [{ prompt: "red or blue?" }, { prompt: "why?" }] })).toBe("red or blue? / why?");
    expect(interactionTitle({ kind: "approval", reason: "Run rm?" })).toBe("Run rm?");
    expect(interactionTitle({ kind: "approval", reason: null })).toBe("approval");
    expect(interactionTitle(null)).toBe("interaction");
  });
});
