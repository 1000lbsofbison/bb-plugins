/**
 * The small decisions around BB's AI-service registration, kept pure so they
 * can be tested without a running BB.
 */

/** BB's selection for one AI-service task, as `bb.sdk.system.aiServices()` reports it. */
export type AiServiceSelection =
  | { mode: "automatic" }
  | { mode: "off" }
  | { mode: "service"; pluginId: string; serviceId: string };

/**
 * Whether BB's voice task is pinned to this plugin's service. "Automatic" is
 * deliberately not counted: it picks by rank, and another provider usually
 * outranks an offline model, so claiming "active" there would be a guess.
 */
export function isSelectedForVoice(
  selection: AiServiceSelection,
  pluginId: string,
  serviceId: string,
): boolean {
  return (
    selection.mode === "service" &&
    selection.pluginId === pluginId &&
    selection.serviceId === serviceId
  );
}

/** The command that points BB's microphone at this plugin. */
export function selectCommand(serviceId: string): string {
  return `bb settings ai-services set voice ${serviceId}`;
}

/**
 * Turn the host's reply into what BB's `transcribe` contract expects: the text,
 * or a rejected promise carrying the plugin's own message.
 */
export function transcriptOrThrow(result: { text: string | null; error: string | null }): string {
  if (result.text !== null) return result.text;
  throw new Error(result.error ?? "Transcription failed without a reason.");
}
