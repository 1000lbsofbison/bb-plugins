// Approvals posted into the thread that started the run — what the chat
// shows, what its agent is told, and which answers may resume the run.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  answerRefusal,
  answerSource,
  approvalMessage,
  approvalSettledMessage,
} from "../lib/approval";

const ask = {
  runId: "run_abc",
  graphName: "Vault inbox sort",
  nodeId: "approval",
  label: "Approval",
  question: "| Note | Target |\n| --- | --- |\n| a.md | Projects |",
};

describe("approvalMessage", () => {
  const [visible, instructions] = approvalMessage(ask);

  it("shows the question verbatim, so its Markdown table renders in the chat", () => {
    expect(visible!.text).toContain(ask.question);
    expect(visible!.visibility).toBeUndefined();
  });

  it("names the run, the node and how to answer", () => {
    expect(visible!.text).toContain("run_abc");
    expect(visible!.text).toContain("**Approval**");
    expect(visible!.text).toContain('bb graph-studio answer run_abc "<answer>"');
  });

  it("tells the agent, and only the agent, to pass the reply on instead of deciding", () => {
    expect(instructions!.visibility).toBe("agent-only");
    expect(instructions!.text).toContain("graph_studio_answer");
    expect(instructions!.text).toContain('nodeId "approval"');
    expect(instructions!.text).toMatch(/Do not answer or approve it yourself/);
  });

  it("keeps the agent instructions out of the visible part", () => {
    expect(visible!.text).not.toContain("graph_studio_answer");
  });
});

describe("approvalSettledMessage", () => {
  it("says the panel answered, and quotes the answer", () => {
    const [visible, instructions] = approvalSettledMessage({
      runId: "run_abc",
      label: "Approval",
      outcome: { kind: "answered", answer: "yes, go", source: "panel" },
    });
    expect(visible!.text).toContain("in the Graph Studio panel");
    expect(visible!.text).toContain("> yes, go");
    expect(instructions!.visibility).toBe("agent-only");
    expect(instructions!.text).toMatch(/do not call graph_studio_answer/);
  });

  it("does not claim the panel for an answer from elsewhere", () => {
    const [visible] = approvalSettledMessage({
      runId: "run_abc",
      label: "Approval",
      outcome: { kind: "answered", answer: "ok", source: "elsewhere" },
    });
    expect(visible!.text).not.toContain("panel");
    expect(visible!.text).toContain("outside this chat");
  });

  it("shortens a long answer instead of repeating it", () => {
    const [visible] = approvalSettledMessage({
      runId: "run_abc",
      label: "Approval",
      outcome: { kind: "answered", answer: "x".repeat(1000), source: "panel" },
    });
    expect(visible!.text).toContain("…");
    expect(visible!.text.length).toBeLessThan(500);
  });

  it("says a stopped run no longer needs the approval", () => {
    const [visible] = approvalSettledMessage({
      runId: "run_abc",
      label: "Approval",
      outcome: { kind: "stopped" },
    });
    expect(visible!.text).toMatch(/was stopped/);
    expect(visible!.text).not.toContain(">");
  });
});

describe("answerRefusal", () => {
  it("lets an answer through to the approval it was meant for", () => {
    expect(
      answerRefusal({ status: "waiting-human", pendingNodeId: "approval", expectedNodeId: "approval" }),
    ).toBeNull();
  });

  it("lets an answer through that names no node (CLI, older callers)", () => {
    expect(
      answerRefusal({ status: "waiting-human", pendingNodeId: "approval", expectedNodeId: undefined }),
    ).toBeNull();
  });

  /** The second of two racing answers: the first already resumed the run. */
  it("refuses once the run is no longer waiting", () => {
    expect(
      answerRefusal({ status: "running", pendingNodeId: null, expectedNodeId: "approval" }),
    ).toMatch(/already settled/);
  });

  /** A late reply to an old question must not answer the next one. */
  it("refuses an answer to an approval that has moved on", () => {
    expect(
      answerRefusal({ status: "waiting-human", pendingNodeId: "final-ok", expectedNodeId: "approval" }),
    ).toMatch(/now waits on "final-ok"/);
  });

  /** After a reload the pending question is gone but the run still waits. */
  it("does not strand a waiting run whose pending question was lost", () => {
    expect(
      answerRefusal({ status: "waiting-human", pendingNodeId: null, expectedNodeId: "approval" }),
    ).toBeNull();
  });
});

describe("answerSource", () => {
  it("counts the starting thread as the chat", () => {
    expect(answerSource("thr_1", "thr_1")).toBe("chat");
  });

  it("counts any other thread, or none, as elsewhere", () => {
    expect(answerSource("thr_2", "thr_1")).toBe("elsewhere");
    expect(answerSource(undefined, "thr_1")).toBe("elsewhere");
    expect(answerSource(null, null)).toBe("elsewhere");
  });
});

/**
 * The wiring in server.ts, read from source for the reason given in
 * agent-tools.test.ts: the host harness cannot reach `drive` or a tool.
 */
describe("server wiring", () => {
  const source = readFileSync("server.ts", "utf8");
  const announce = source.slice(
    source.indexOf("function announceApproval"),
    source.indexOf("function settleAnnouncement"),
  );

  it("announces when a run starts waiting", () => {
    const waiting = source.slice(source.indexOf("pending.set(runId, value)"));
    expect(waiting.slice(0, 400)).toContain("announceApproval(row, value)");
  });

  it("posts only for runs with a starting thread, and only for human nodes", () => {
    expect(announce).toContain("if (!row.threadId) return;");
    expect(announce).toContain('node?.kind !== "human"');
  });

  it("queues rather than steers, so the turn that started the run is not cut short", () => {
    const post = source.slice(source.indexOf("async function postToThread"));
    expect(post.slice(0, 600)).toContain('mode: "queue-if-active"');
  });

  it("does not echo an answer back into the chat it came from", () => {
    const start = source.indexOf("function settleAnnouncement");
    const settle = source.slice(start, start + 800);
    expect(settle).toContain('outcome.source === "chat") return;');
  });

  it("registers graph_studio_answer with the caller's thread as the source", () => {
    const start = source.indexOf('name: "graph_studio_answer"');
    expect(start).toBeGreaterThan(-1);
    const tool = source.slice(start, source.indexOf("registerTool", start));
    expect(tool).toContain("answerSource(ctx.threadId, row.threadId)");
    expect(tool).toMatch(/never approve or answer on your own/);
  });

  it("marks panel answers as the panel's and passes the node it showed", () => {
    expect(source).toContain('answerHuman(runId, answer, { source: "panel", nodeId })');
  });
});
