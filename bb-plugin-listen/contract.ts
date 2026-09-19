/**
 * The RPC contract between the server entry and the host worker.
 *
 * Shared by both sides so a rename breaks the build rather than a recording.
 * BB's own `ai.voice.transcribe` is answered by the same worker but declared
 * elsewhere — see the note on `hostContract` for why it cannot live here.
 */

import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** A model as the settings page sees it: catalog facts plus disk reality. */
export const modelStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  sizeBytes: z.number(),
  notes: z.string(),
  languages: z.string(),
  accuracy: z.number(),
  speed: z.number(),
  tier: z.enum(["edge", "standard", "heavy"]),
  recommended: z.boolean(),
  installed: z.boolean(),
  /** "plugin" when we downloaded it, "pi" when borrowed from pi-listen. */
  source: z.enum(["plugin", "pi", "none"]),
  /** Present while a download is running. */
  progress: z
    .object({ downloadedBytes: z.number(), totalBytes: z.number() })
    .nullable(),
  /** Set when the last download attempt failed. */
  error: z.string().nullable(),
});
export type ModelState = z.infer<typeof modelStateSchema>;

/** A voice model, plus the individual voices it contains. */
export const voiceStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  notes: z.string(),
  languages: z.array(z.string()),
  license: z.string(),
  recommended: z.boolean(),
  installed: z.boolean(),
  source: z.enum(["plugin", "pi", "none"]),
  voices: z.array(z.object({ sid: z.number(), name: z.string() })),
  defaultSid: z.number(),
  progress: z
    .object({ phase: z.string(), bytes: z.number(), totalBytes: z.number() })
    .nullable(),
  error: z.string().nullable(),
});
export type VoiceState = z.infer<typeof voiceStateSchema>;

export const setupStateSchema = z.object({
  runtime: z.object({
    installed: z.boolean(),
    source: z.enum(["plugin", "pi", "none"]),
    unsupported: z.string().nullable(),
    installing: z.boolean(),
    error: z.string().nullable(),
  }),
  ffmpeg: z.boolean(),
  /** Path to a usable Node, which speaking needs. Null when none was found. */
  node: z.string().nullable(),
  device: z.object({
    platform: z.string(),
    arch: z.string(),
    cpus: z.number(),
    totalRamMB: z.number(),
    freeDiskMB: z.number(),
  }),
  /** Recommended model id for this hardware, from the device profile. */
  recommendedModel: z.string(),
});
export type SetupState = z.infer<typeof setupStateSchema>;

/**
 * Settings the host needs but cannot be told per call.
 *
 * BB's `ai.voice.transcribe` carries no language, so the choice has to reach
 * the worker some other way. The server pushes it here whenever the plugin's
 * settings change and the host keeps it on disk, because core may start a
 * fresh worker for a transcription without the server saying anything first.
 */
export const hostConfigSchema = z.object({
  /** BCP-47 tag. Ignored by models that detect the language themselves. */
  language: z.string(),
  /** Voice model used for speaking, and which of its voices. */
  voiceModel: z.string(),
  voiceSid: z.number(),
  /** 1 is the model's natural pace; higher is faster. */
  voiceSpeed: z.number(),
});
export type HostConfig = z.infer<typeof hostConfigSchema>;

/**
 * The plugin's own host methods.
 *
 * BB's `ai.voice.transcribe` is deliberately *not* folded in here. Its schema
 * lives in `@get-bb/plugin-sdk/ai-services`, a subpath only host artifacts can
 * resolve — importing it from a file the server entry also loads fails the
 * plugin load outright. The host merges the two contracts on its own side.
 */
export const hostContract = defineRpcContract({
  /** Everything the settings page renders, in one round trip. */
  state: {
    input: z.null(),
    output: z.object({
      setup: setupStateSchema,
      sttModels: z.array(modelStateSchema),
      voices: z.array(voiceStateSchema),
      config: hostConfigSchema,
    }),
  },

  /** Download and unpack a voice model. Returns at once, like the STT one. */
  downloadVoice: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ started: z.boolean() }),
  },

  cancelVoiceDownload: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ cancelled: z.boolean() }),
  },

  deleteVoice: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ deleted: z.boolean() }),
  },

  /**
   * Speak text. The audio comes back as a WAV rather than being played here:
   * the host may be a machine nobody is sitting at, and the browser that
   * shows the thread is the thing with speakers.
   */
  speak: {
    input: z.object({
      text: z.string(),
      /** Overrides the configured voice, for the settings page's preview. */
      modelId: z.string().nullable(),
      sid: z.number().nullable(),
    }),
    output: z.object({
      wavBase64: z.string(),
      sampleRate: z.number(),
      milliseconds: z.number(),
    }),
  },

  setConfig: {
    input: hostConfigSchema,
    output: hostConfigSchema,
  },

  /**
   * Transcribe a file already on the host's disk.
   *
   * The same path BB's microphone takes, reachable without a microphone. It
   * reads the file on the host rather than shipping base64 through RPC, so it
   * is also the only way to try a recording larger than the 8 MiB call limit.
   */
  transcribeFile: {
    input: z.object({ path: z.string(), modelId: z.string() }),
    output: z.object({
      text: z.string().nullable(),
      error: z.string().nullable(),
      milliseconds: z.number(),
    }),
  },

  /** Install the native runtime. Returns at once; progress arrives as signals. */
  installRuntime: {
    input: z.null(),
    output: z.object({ started: z.boolean() }),
  },

  /**
   * Start a model download. Returns at once because these run for minutes and
   * a host call has a 30-second budget.
   */
  downloadModel: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ started: z.boolean() }),
  },

  cancelDownload: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ cancelled: z.boolean() }),
  },

  deleteModel: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ deleted: z.boolean() }),
  },
});

/**
 * Progress notifications. Ephemeral by contract: the payload says only that
 * something moved, and the server re-reads `state` rather than trusting it as
 * a running total.
 */
export const hostSignals = {
  changed: {
    payload: z.object({
      reason: z.enum(["runtime", "download", "error"]),
      modelId: z.string().nullable(),
    }),
  },
} satisfies ExperimentalHostSignals;
