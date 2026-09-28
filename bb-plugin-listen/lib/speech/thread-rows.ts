/**
 * Which sidebar thread rows carry the speaker glyph.
 *
 * A thread that chose to speak shows it quietly; the thread whose answer is
 * being read right now shows it shimmering, so a voice coming out of the
 * speakers can be traced back to a row without opening anything.
 */

export const SPEAKER_ICON = "listen-speaker";

export interface RowStatus {
  icon: string;
  label: string;
  tone: "default" | "running";
}

export function rowStatuses(
  marked: readonly string[],
  speakingThreadId: string | null,
): Map<string, RowStatus> {
  const statuses = new Map<string, RowStatus>();
  for (const threadId of marked) {
    statuses.set(threadId, {
      icon: SPEAKER_ICON,
      label: "Answers are read aloud",
      tone: "default",
    });
  }
  if (speakingThreadId !== null) {
    statuses.set(speakingThreadId, {
      icon: SPEAKER_ICON,
      label: "Reading the answer aloud",
      tone: "running",
    });
  }
  return statuses;
}

type SetStatus = (threadId: string, status: RowStatus | null) => void;

/**
 * Applies a new set of statuses, clearing rows that dropped out. The host
 * keeps a status until told otherwise, so forgetting a row would leave a
 * speaker on a thread that has long stopped speaking.
 */
export function createRowSync(set: SetStatus) {
  let shown = new Map<string, RowStatus>();
  return (next: Map<string, RowStatus>) => {
    for (const threadId of shown.keys()) {
      if (!next.has(threadId)) set(threadId, null);
    }
    for (const [threadId, status] of next) {
      const before = shown.get(threadId);
      if (before?.tone !== status.tone || before.label !== status.label) {
        set(threadId, status);
      }
    }
    shown = next;
  };
}
