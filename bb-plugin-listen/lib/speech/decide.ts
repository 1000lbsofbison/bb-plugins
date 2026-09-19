/**
 * When to speak, and what.
 *
 * Pulled out of the event handler because both decisions fail quietly: the
 * wrong answer is silence, and silence is what a switched-off feature looks
 * like too. Here they are plain functions with a test each way round.
 */

import { prepareForSpeech } from "./text-filter.js";

export interface IdleThread {
  id: string;
  visibility?: string;
}

export interface SpeakContext {
  /** The "Read answers aloud" setting — the default for every thread. */
  enabled: boolean;
  /**
   * This thread's own choice, from the speaker button in its composer.
   * `null` means the thread has no opinion and follows the setting.
   */
  override: boolean | null;
  /** The finished answer, as BB reports it. */
  lastAssistantText: string | null;
  /** Hidden threads this plugin started, which must not feed themselves. */
  ourWorkers: ReadonlySet<string>;
}

/**
 * Whether a thread speaks: its own choice if it made one, otherwise the
 * global setting. Exported because the composer button shows this same
 * answer, and the two must never disagree.
 */
export function speaksAloud(context: {
  enabled: boolean;
  override: boolean | null;
}): boolean {
  return context.override ?? context.enabled;
}

export type SkipReason =
  | "disabled"
  | "no-answer"
  | "own-worker"
  | "hidden-thread";

/**
 * Decide whether a finished turn should be read aloud.
 *
 * `own-worker` is the one that bites: the summary thread finishing is itself
 * a `thread.idle`, and speaking it would summarize the summary, forever.
 */
export function shouldSpeak(
  thread: IdleThread,
  context: SpeakContext,
): { speak: true } | { speak: false; reason: SkipReason } {
  if (!speaksAloud(context)) return { speak: false, reason: "disabled" };
  if (context.lastAssistantText === null || context.lastAssistantText.trim() === "") {
    return { speak: false, reason: "no-answer" };
  }
  if (context.ourWorkers.has(thread.id)) {
    return { speak: false, reason: "own-worker" };
  }
  // Any other hidden thread is someone's background worker; its output was
  // never meant for a person's ears either.
  if (thread.visibility === "hidden") {
    return { speak: false, reason: "hidden-thread" };
  }
  return { speak: true };
}

/** How long a raw answer may be before speaking it becomes a punishment. */
const RAW_ANSWER_MAX_CHARS = 1200;

/** The stand-ins `prepareForSpeech` leaves behind for what it removed. */
const PLACEHOLDERS = /\[(?:code block|link) omitted\]/g;

/**
 * Choose the text to speak.
 *
 * A summary is already spoken prose and is used as-is. Without one the raw
 * answer is stripped of markdown, code and emoji and spoken anyway — a long
 * answer is a worse outcome than a short one, but both beat silence, which
 * reads as a broken feature.
 */
export function spokenText(
  summary: string | null,
  answer: string,
  /** BCP-47 tag; decides whether the filter's English-only rules apply. */
  language?: string,
): { text: string; source: "summary" | "answer" } | null {
  const trimmedSummary = summary?.trim() ?? "";
  if (trimmedSummary !== "") {
    // A summary is *mostly* spoken prose, but a small model asked for plain
    // text still returns `settings.onChange` in backticks now and then, and
    // backticks get read out. The filter is cheap and idempotent, so it runs
    // on the summary too rather than trusting the prompt to have been obeyed.
    const prepared = prepareForSpeech(trimmedSummary, {
      maxChars: RAW_ANSWER_MAX_CHARS,
      language,
    });
    const cleaned = prepared.skipped ? trimmedSummary : prepared.text;
    return { text: cleaned, source: "summary" };
  }

  const prepared = prepareForSpeech(answer, {
    maxChars: RAW_ANSWER_MAX_CHARS,
    language,
  });
  if (prepared.skipped) return null;
  // The filter leaves placeholders where it removed things. An answer that
  // was nothing but a code block reduces to "code block omitted", and
  // reading that out is worse than staying quiet.
  const speakable = prepared.text.replace(PLACEHOLDERS, " ").trim();
  if (speakable === "") return null;
  return { text: prepared.text, source: "answer" };
}
