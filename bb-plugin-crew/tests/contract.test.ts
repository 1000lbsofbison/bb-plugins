import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CONTRACT_VERSION } from "../lib/contract";
import { replyFromEvents } from "../lib/reply";
import plugin from "../server";
import { PROJECT, running, setup } from "./helpers";

async function trio() {
  const env = setup();
  const crew = await running(env.service, env.port);
  return { ...env, ...crew };
}

describe("replyFromEvents", () => {
  const request = (seq: number, requestId: string, text: string) => ({ seq, type: "client/turn/requested", data: { requestId, input: [{ type: "text", text }] } });
  const accepted = (seq: number, requestId: string) => ({ seq, type: "turn/input/accepted", data: { clientRequestId: requestId } });
  const said = (seq: number, text: string) => ({ seq, type: "item/completed", data: { item: { type: "agentMessage", text } } });
  const done = (seq: number, status = "completed") => ({ seq, type: "turn/completed", data: { status } });

  it("takes the last assistant text of the turn that accepted the marked request", () => {
    const events = [request(1, "r1", "earlier"), accepted(2, "r1"), said(3, "old answer"), done(4), request(5, "r2", "… msg msg_7 …"), accepted(6, "r2"), said(7, "draft"), said(8, "final"), done(9)];
    expect(replyFromEvents(events, "msg msg_7")).toEqual({ state: "completed", text: "final", cursor: 9 });
  });

  it("negative: no marked request → waiting; another request's answer is not taken; unfinished → running; failed turn → failed", () => {
    expect(replyFromEvents([request(1, "r1", "x"), accepted(2, "r1"), said(3, "no"), done(4)], "msg msg_7").state).toBe("waiting");
    // Queued behind another turn: that turn's answer belongs to r1, not to the marked r2.
    const queued = [request(1, "r1", "x"), request(2, "r2", "msg msg_7"), accepted(3, "r1"), said(4, "for r1"), done(5), accepted(6, "r2")];
    expect(replyFromEvents(queued, "msg msg_7")).toEqual({ state: "running", text: null, cursor: 6 });
    expect(replyFromEvents([request(1, "r1", "msg msg_7"), accepted(2, "r1"), said(3, "partial"), done(4, "failed")], "msg msg_7")).toEqual({ state: "failed", text: "partial", cursor: 4 });
  });
});

describe("§4.8 contract", () => {
  it("sendToMember is idempotent on correlationId: one message, one delivery", async () => {
    const t = await trio();
    const input = { projectId: PROJECT, address: "dev-impl@trio", body: "Build it.", from: "graph-studio", correlationId: "run1:node1:1:1" };
    const first = await t.service.contract.sendToMember(input);
    const second = await t.service.contract.sendToMember({ ...input, body: "different text, same call" });
    expect(first).toMatchObject({ contractVersion: CONTRACT_VERSION, duplicate: false, status: "delivered", error: null });
    expect(second).toMatchObject({ contractVersion: 1, messageId: first.messageId, duplicate: true });
    expect(t.store.listMessages({ projectId: PROJECT }).filter((m) => m.fromAddress === "plugin:graph-studio")).toHaveLength(1);
    const inbox = t.port.threads.get(t.threads["dev-impl"]!)!.inbox.filter((e) => e.text.includes(`msg ${first.messageId}`));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.text).toContain("From: plugin:graph-studio");
    expect(inbox[0]!.text).toContain("answer in your reply text");
    // A new correlationId is a new call.
    const third = await t.service.contract.sendToMember({ ...input, correlationId: "run1:node1:1:2" });
    expect(third.messageId).not.toBe(first.messageId);
  });

  it("negative: an unknown address is rejected without a row and without remembering the correlationId", async () => {
    const t = await trio();
    const result = await t.service.contract.sendToMember({ projectId: PROJECT, address: "dev-ghost@trio", body: "x", from: "gs", correlationId: "c1" });
    expect(result).toMatchObject({ contractVersion: 1, messageId: null, status: "rejected" });
    expect(result.error).toContain("dev-ghost");
    expect(t.store.rpcSend("c1")).toBeNull();
  });

  it("memberReply: running until the turn completes, then the first completed answer; held and refused say so", async () => {
    const t = await trio();
    const sent = await t.service.contract.sendToMember({ projectId: PROJECT, address: "dev-impl@trio", body: "2+2?", from: "gs", correlationId: "c1" });
    expect(await t.service.contract.memberReply(sent.messageId!)).toMatchObject({ contractVersion: 1, status: "running", text: null });
    t.port.answer(t.threads["dev-impl"]!, `msg ${sent.messageId}`, "4");
    const reply = await t.service.contract.memberReply(sent.messageId!);
    expect(reply).toMatchObject({ contractVersion: 1, status: "completed", text: "4", threadId: t.threads["dev-impl"] });
    expect(reply.eventCursor).toBeGreaterThan(0);

    t.port.threads.get(t.threads["dev-review"]!)!.interactions.push({ id: "i", kind: "question", title: "?" });
    const held = await t.service.contract.sendToMember({ projectId: PROJECT, address: "dev-review@trio", body: "x", from: "gs", correlationId: "c2" });
    expect(held.status).toBe("on_hold");
    expect(await t.service.contract.memberReply(held.messageId!)).toMatchObject({ status: "held" });
    expect(await t.service.contract.memberReply("msg_nope")).toMatchObject({ status: "refused" });
  });

  it("memberReply names an unreadable event log instead of looking like a slow member; negative: a readable log leaves text null", async () => {
    const t = await trio();
    const sent = await t.service.contract.sendToMember({ projectId: PROJECT, address: "dev-impl@trio", body: "q", from: "gs", correlationId: "c1" });
    expect((await t.service.contract.memberReply(sent.messageId!)).text).toBeNull();
    t.port.reply = async () => {
      throw new Error("HTTP 400: Thread event limit cannot exceed 100");
    };
    const reply = await t.service.contract.memberReply(sent.messageId!);
    expect(reply.status).toBe("running");
    expect(reply.text).toContain("events unreadable");
    expect(reply.text).toContain("cannot exceed 100");
  });

  it("memberReply follows a handover: the answer may come from the old shift's thread", async () => {
    const t = await trio();
    const sent = await t.service.contract.sendToMember({ projectId: PROJECT, address: "dev-impl@trio", body: "q", from: "gs", correlationId: "c1" });
    t.port.answer(t.threads["dev-impl"]!, `msg ${sent.messageId}`, "from shift 1");
    await t.service.lifecycle.handover(t.crew, "dev-impl", { brief: "b" });
    expect(await t.service.contract.memberReply(sent.messageId!)).toMatchObject({ status: "completed", text: "from shift 1", threadId: t.threads["dev-impl"] });
  });

  it("resolveMember and listMembers carry contractVersion; an unknown member is null with a reason", async () => {
    const t = await trio();
    const found = await t.service.contract.resolveMember(PROJECT, "dev-impl@trio");
    expect(found).toMatchObject({ contractVersion: 1, error: null, member: { address: "dev-impl@trio", crew: "trio", threadId: t.threads["dev-impl"], shift: 1, lead: false } });
    expect(await t.service.contract.resolveMember(PROJECT, "dev-ghost@trio")).toMatchObject({ contractVersion: 1, member: null });
    const list = await t.service.contract.listMembers(PROJECT, "trio");
    expect(list.contractVersion).toBe(1);
    expect(list.members.map((m) => m.key)).toEqual(["orch-lead", "dev-impl", "dev-review"]);
    expect((await t.service.contract.listMembers(PROJECT, "nope")).members).toEqual([]);
  });

  it("is registered as RPC methods on the server", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "crew" });
    await plugin(bb);
    for (const method of ["resolveMember", "sendToMember", "listMembers", "memberReply"]) expect(harness.registrations.rpcMethods).toContain(method);
    expect(await harness.behavior.callRpc("listMembers", { projectId: "p1" })).toEqual({ contractVersion: 1, members: [] });
    expect(await harness.behavior.callRpc("memberReply", { messageId: "msg_x" })).toMatchObject({ contractVersion: 1, status: "refused" });
    await harness.lifecycle.dispose();
  });
});
