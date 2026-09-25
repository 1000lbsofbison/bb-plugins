// Approvals in the thread that started the run.
//
// A human node used to ask only in the Graph Studio panel. The person who
// started the run is usually in the chat of the thread that started it, not in
// the panel, so the run sat waiting on a question nobody saw. Now the question
// is also posted into that thread, and the thread's agent passes the reply on
// with `graph_studio_answer`. The panel stays as a second way; whichever
// answers first wins, and the chat is told when the panel got there first.
//
// Pure functions only: what gets posted and who may answer. Sending lives in
// server.ts, so this stays testable without a host.

/** One part of a `threads.send` input, the subset this module produces. */
export type MessagePart = {
  type: "text";
  text: string;
  mentions: [];
  /** `agent-only`: instructions the agent reads and the chat does not show. */
  visibility?: "agent-only";
};

export type ApprovalAsk = {
  runId: string;
  graphName: string;
  nodeId: string;
  label: string;
  /** Already rendered; usually Markdown, often with tables. */
  question: string;
};

/** Where an answer came from. `chat` is the thread that started the run. */
export type AnswerSource = "chat" | "panel" | "elsewhere";

/**
 * The approval as it appears in the starting thread.
 *
 * The visible part is for the person: the question as Markdown, and how to
 * answer. The agent-only part is for the thread's agent, which receives this
 * as a new turn and would otherwise try to be helpful — answer the question
 * itself, or approve on the user's behalf. An approval is the user's decision.
 */
export function approvalMessage(ask: ApprovalAsk): MessagePart[] {
  const visible = [
    `**Graph Studio is waiting for your approval** · ${ask.graphName} · node **${ask.label}**`,
    "",
    ask.question,
    "",
    "---",
    `Reply here and your answer goes to run \`${ask.runId}\`. ` +
      "You can also answer in the Graph Studio panel, or with " +
      `\`bb graph-studio answer ${ask.runId} "<answer>"\`. ` +
      "Whichever comes first counts.",
  ].join("\n");
  const instructions = [
    "This message was posted by the Graph Studio plugin, not typed by the user.",
    `Run ${ask.runId} is paused at the human node "${ask.nodeId}" and needs the user's decision.`,
    "Do not answer or approve it yourself. Reply with one short line saying you are waiting for their answer.",
    "When the user replies to it, call graph_studio_answer with " +
      `runId "${ask.runId}", nodeId "${ask.nodeId}" and the user's answer in their own words.`,
    "If the tool reports that the approval was already answered, tell the user and do not retry.",
  ].join(" ");
  return [
    { type: "text", text: visible, mentions: [] },
    { type: "text", text: instructions, mentions: [], visibility: "agent-only" },
  ];
}

/** Long enough to recognise the answer, short enough not to repeat a table. */
const QUOTE_LIMIT = 280;

/**
 * The note that closes an approval in the chat when it was settled somewhere
 * else — so nobody answers a question that is already gone.
 */
export function approvalSettledMessage(args: {
  runId: string;
  label: string;
  outcome: { kind: "answered"; answer: string; source: AnswerSource } | { kind: "stopped" };
}): MessagePart[] {
  const where =
    args.outcome.kind === "answered" && args.outcome.source === "panel"
      ? "in the Graph Studio panel"
      : "outside this chat";
  const visible =
    args.outcome.kind === "stopped"
      ? `Graph Studio: run \`${args.runId}\` was stopped. The approval **${args.label}** is no longer needed.`
      : `Graph Studio: the approval **${args.label}** of run \`${args.runId}\` was answered ${where} — no reply needed here.\n\n> ${quote(args.outcome.answer)}`;
  const instructions =
    "Informational note from the Graph Studio plugin. The approval is settled: " +
    "do not call graph_studio_answer for it. Acknowledge in one short line at most.";
  return [
    { type: "text", text: visible, mentions: [] },
    { type: "text", text: instructions, mentions: [], visibility: "agent-only" },
  ];
}

function quote(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_LIMIT ? `${flat.slice(0, QUOTE_LIMIT - 1)}…` : flat;
}

/**
 * Whether an answer may resume the run, and if not, why.
 *
 * `expectedNodeId` is the approval the answerer saw. Without it, a reply to an
 * old question — typed in the chat after the panel had already moved the run
 * on to the next approval — would silently answer a question its author never
 * read.
 */
export function answerRefusal(args: {
  status: string;
  pendingNodeId: string | null;
  expectedNodeId: string | undefined;
}): string | null {
  if (args.status !== "waiting-human") {
    return `That approval was already settled — the run is ${args.status} now and not waiting for an answer.`;
  }
  // The pending question lives in memory and is gone after a plugin reload.
  // The run still waits then, and refusing would strand it; so the node check
  // applies only when both sides are known.
  if (
    args.expectedNodeId !== undefined &&
    args.pendingNodeId !== null &&
    args.expectedNodeId !== args.pendingNodeId
  ) {
    return `That approval ("${args.expectedNodeId}") was already answered; the run now waits on "${args.pendingNodeId}". Show the user the new question before answering it.`;
  }
  return null;
}

/** Answers from the starting thread are the chat; its own note is not needed. */
export function answerSource(
  callerThreadId: string | null | undefined,
  runThreadId: string | null,
): AnswerSource {
  return callerThreadId != null && callerThreadId === runThreadId ? "chat" : "elsewhere";
}
