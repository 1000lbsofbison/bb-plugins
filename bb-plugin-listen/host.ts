/**
 * The host worker: everything native, everything large.
 *
 * It runs on the machine that owns the microphone recording, loads the
 * sherpa-onnx addon, keeps the model files, and transcribes the recordings
 * the server's AI service forwards whenever BB picks this plugin for voice. The server entry never touches any of it — a bundled server cannot
 * carry a native addon, and this worker can.
 *
 * Downloads and the runtime install run detached from the call that starts
 * them: a host call has a 30-second budget and a model is hundreds of
 * megabytes. Callers get `{ started: true }`, the work holds the worker open
 * with a lease, and progress arrives as signals.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostConfigSchema,
  hostContract,
  hostSignals,
  type HostConfig,
  type ModelState,
  type SetupState,
  type VoiceState,
} from "./contract.js";
import { decodeToPcm16k, AudioDecodeError, hasFfmpeg } from "./host/audio.js";
import { detectDevice, autoRecommendModel } from "./host/device.js";
import {
  deleteModel as deleteModelFiles,
  downloadModel,
  getFreeDiskSpace,
  getModelsDir,
  resolveModelDir,
  setModelsDir,
  piModelsDir,
} from "./host/download.js";
import {
  DEFAULT_TTS_MODEL,
  TTS_LOCAL_MODELS,
  ensureTtsModelInstalled,
  getTtsModel,
  getTtsModelDir,
  piTtsModelsDir,
  resolveTtsModelDir,
  setTtsModelsDir,
  type TtsInstallProgress,
} from "./host/tts-catalog.js";
import { buildTtsConfig, clearTtsCache, resolveLanguageForLocal } from "./host/tts.js";
import { findNode, stopSynthesis, synthesizeInProcess } from "./host/synth-process.js";
import { LOCAL_MODELS, DEFAULT_LOCAL_MODEL, getLanguagesForLocalModel } from "./host/stt-catalog.js";
import type { LocalModelInfo } from "./host/stt-catalog.js";
import { getOrCreateRecognizer, transcribeBuffer, clearRecognizerCache } from "./host/stt.js";
import {
  installRuntime,
  loadSherpa,
  probeRuntime,
  resetRuntime,
  setRuntimeDataDir,
  type RuntimeSource,
} from "./host/runtime.js";
import { join } from "node:path";

/** Transient per-worker state. Durable truth is the file system. */
interface Download {
  controller: AbortController;
  downloadedBytes: number;
  totalBytes: number;
}
const downloads = new Map<string, Download>();
const downloadErrors = new Map<string, string>();

/** Voice installs, tracked separately: they extract as well as download. */
interface VoiceInstall {
  controller: AbortController;
  phase: string;
  bytes: number;
  totalBytes: number;
}
const voiceInstalls = new Map<string, VoiceInstall>();
const voiceErrors = new Map<string, string>();
let runtimeInstalling = false;
let runtimeError: string | null = null;

/** Set on the first call; the host learns its data directory only then. */
let dataDir: string | null = null;

function useDataDir(directory: string): string {
  if (dataDir === null) {
    dataDir = directory;
    setModelsDir(join(directory, "models"));
    setTtsModelsDir(join(directory, "models", "tts"));
    setRuntimeDataDir(directory);
  }
  return dataDir;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: HostConfig = {
  language: "en",
  voiceModel: DEFAULT_TTS_MODEL,
  voiceSid: 0,
  voiceSpeed: 1,
};
let config: HostConfig | null = null;

function configPath(directory: string): string {
  return join(directory, "config.json");
}

/**
 * Read the config the server last pushed.
 *
 * On disk rather than in memory because core can start a fresh worker for a
 * transcription without the server getting a word in first, and a recording
 * transcribed in the wrong language is worse than a slow read.
 */
function readConfig(directory: string): HostConfig {
  if (config !== null) return config;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(directory), "utf8"));
    config = hostConfigSchema.parse(parsed);
  } catch {
    // Absent, unreadable or written by an older version — the default is
    // always usable, and the server overwrites it on its next load.
    config = DEFAULT_CONFIG;
  }
  return config;
}

function findModel(modelId: string): LocalModelInfo | undefined {
  return LOCAL_MODELS.find((model) => model.id === modelId);
}

/** Language summary for the settings list, e.g. "25 languages" or "English". */
function describeLanguages(model: LocalModelInfo): string {
  const { languages, englishOnly } = getLanguagesForLocalModel(model.id);
  if (englishOnly) return "English";
  return languages.length > 1 ? `${languages.length} languages` : languages[0]?.name ?? "—";
}

function describeModel(model: LocalModelInfo): ModelState {
  const directory = resolveModelDir(model.id, model.sherpaModel.downloadUrls);
  const running = downloads.get(model.id);
  const source: RuntimeSource =
    directory === null
      ? "none"
      : directory.startsWith(piModelsDir())
        ? "pi"
        : "plugin";
  return {
    id: model.id,
    name: model.name,
    size: model.size,
    sizeBytes: model.sizeBytes,
    notes: model.notes,
    languages: describeLanguages(model),
    accuracy: model.accuracy,
    speed: model.speed,
    tier: model.tier,
    recommended: model.preferred === true,
    installed: directory !== null,
    source,
    progress:
      running === undefined
        ? null
        : { downloadedBytes: running.downloadedBytes, totalBytes: running.totalBytes },
    error: downloadErrors.get(model.id) ?? null,
  };
}

function describeVoice(model: (typeof TTS_LOCAL_MODELS)[number]): VoiceState {
  const directory = resolveTtsModelDir(model.id);
  const running = voiceInstalls.get(model.id);
  return {
    id: model.id,
    name: model.name,
    size: model.size,
    notes: model.incompatible ?? model.notes,
    languages: model.languages,
    license: model.license,
    recommended: model.preferred === true,
    installed: directory !== null,
    source:
      directory === null
        ? "none"
        : directory.startsWith(piTtsModelsDir())
          ? "pi"
          : "plugin",
    voices: model.voices.map((voice) => ({ sid: voice.sid, name: voice.name })),
    defaultSid: model.defaultSid,
    progress:
      running === undefined
        ? null
        : { phase: running.phase, bytes: running.bytes, totalBytes: running.totalBytes },
    error: voiceErrors.get(model.id) ?? null,
  };
}

function describeSetup(directory: string): SetupState {
  const runtime = probeRuntime(directory);
  const device = detectDevice();
  const recommended =
    autoRecommendModel(LOCAL_MODELS, device, "en")?.id ?? DEFAULT_LOCAL_MODEL;
  return {
    runtime: {
      installed: runtime.installed,
      source: runtime.source,
      unsupported: runtime.unsupported,
      installing: runtimeInstalling,
      error: runtimeError,
    },
    // Resolved lazily at call time rather than cached: a user who installs
    // ffmpeg after seeing the warning should see it clear on the next refresh.
    ffmpeg: false,
    node: findNode(),
    device: {
      platform: device.platform,
      arch: device.arch,
      cpus: device.cpuCores,
      totalRamMB: device.totalRamMB,
      freeDiskMB: getFreeDiskSpace(getModelsDir()) ?? 0,
    },
    recommendedModel: recommended,
  };
}

/** Why a transcription could not be attempted, phrased for the user. */
interface NotReady {
  code: "request_failed" | "service_unavailable";
  message: string;
}

/**
 * The one transcription path, shared by BB's microphone and the diagnostic
 * command. Returns a `NotReady` instead of throwing so both callers can shape
 * the same facts into their own reply.
 */
async function transcribe(
  directory: string,
  modelId: string,
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ text: string } | NotReady> {
  const model = findModel(modelId);
  if (model === undefined) {
    return {
      code: "request_failed",
      message: `Unknown model "${modelId}". Pick one on the Listen settings page.`,
    };
  }

  const modelDir = resolveModelDir(model.id, model.sherpaModel.downloadUrls);
  if (modelDir === null) {
    return {
      code: "service_unavailable",
      message: `The model "${model.name}" is not downloaded yet. Download it on the Listen settings page.`,
    };
  }

  if (!(await loadSherpa(directory))) {
    return {
      code: "service_unavailable",
      message:
        "The speech runtime is not installed. Install it on the Listen settings page.",
    };
  }

  try {
    const pcm = await decodeToPcm16k(audio, mimeType, signal);
    const recognizer = getOrCreateRecognizer(model, modelDir, readConfig(directory).language);
    return { text: await transcribeBuffer(pcm, recognizer) };
  } catch (cause) {
    return {
      // A missing decoder is a configuration problem the user can fix; core
      // should not retry it as if the service had blinked.
      code:
        cause instanceof AudioDecodeError && cause.needsFfmpeg
          ? "service_unavailable"
          : "request_failed",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    // ─── BB's transcription service ────────────────────────────────────────
    //
    // Failures are returned, never thrown: a thrown error would reach the
    // user as a transport failure rather than "download the model first".
    transcribeAudio: async (input, context) => {
      const directory = useDataDir(context.experimental_paths.dataDir);
      const result = await transcribe(
        directory,
        input.modelId,
        Buffer.from(input.audioBase64, "base64"),
        input.mimeType,
        context.signal,
      );
      return "text" in result
        ? { text: result.text, error: null }
        : { text: null, error: result.message };
    },

    transcribeFile: async ({ path, modelId }, context) => {
      const directory = useDataDir(context.experimental_paths.dataDir);
      const started = Date.now();
      let audio: Buffer;
      try {
        audio = readFileSync(path);
      } catch (cause) {
        return {
          text: null,
          error: `Could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          milliseconds: Date.now() - started,
        };
      }
      // The extension is the only format hint a file carries; the decoder
      // sniffs the actual bytes anyway.
      const result = await transcribe(
        directory,
        modelId,
        audio,
        `audio/${path.split(".").pop() ?? "wav"}`,
        context.signal,
      );
      return "text" in result
        ? { text: result.text, error: null, milliseconds: Date.now() - started }
        : { text: null, error: result.message, milliseconds: Date.now() - started };
    },

    // ─── The settings page ─────────────────────────────────────────────────

    state: async (_input, context) => {
      const directory = useDataDir(context.experimental_paths.dataDir);
      const setup = describeSetup(directory);
      return {
        setup: { ...setup, ffmpeg: await hasFfmpeg() },
        sttModels: LOCAL_MODELS.map(describeModel),
        voices: TTS_LOCAL_MODELS.map(describeVoice),
        config: readConfig(directory),
      };
    },

    setConfig: async (next, context) => {
      const directory = useDataDir(context.experimental_paths.dataDir);
      config = hostConfigSchema.parse(next);
      // The recognizer is built for one language; a change must retire it.
      clearRecognizerCache();
      mkdirSync(directory, { recursive: true });
      writeFileSync(configPath(directory), `${JSON.stringify(config, null, 2)}\n`);
      return config;
    },

    installRuntime: async (_input, context) => {
      const directory = useDataDir(context.experimental_paths.dataDir);
      if (runtimeInstalling) return { started: false };
      runtimeInstalling = true;
      runtimeError = null;

      // The lease keeps the worker alive past this call's return; without it
      // an idle eviction would kill npm mid-install.
      const lease = context.experimental_retainWorker();
      void (async () => {
        try {
          await installRuntime(directory);
          // A previous failed load is cached per process; forget it so the
          // fresh install is picked up without reloading the plugin.
          resetRuntime();
        } catch (cause) {
          runtimeError = cause instanceof Error ? cause.message : String(cause);
        } finally {
          runtimeInstalling = false;
          lease.dispose();
          await context.experimental_emitSignal("changed", {
            reason: runtimeError === null ? "runtime" : "error",
            modelId: null,
          });
        }
      })();
      return { started: true };
    },

    downloadModel: async ({ modelId }, context) => {
      const directory = useDataDir(context.experimental_paths.dataDir);
      const model = findModel(modelId);
      if (model === undefined) throw new Error(`Unknown model "${modelId}".`);
      if (downloads.has(modelId)) return { started: false };

      const controller = new AbortController();
      const entry: Download = {
        controller,
        downloadedBytes: 0,
        totalBytes: model.sizeBytes,
      };
      downloads.set(modelId, entry);
      downloadErrors.delete(modelId);

      const lease = context.experimental_retainWorker();
      void (async () => {
        let lastSignal = 0;
        try {
          await downloadModel(
            {
              modelId,
              files: model.sherpaModel.downloadUrls,
              totalSizeBytes: model.sizeBytes,
            },
            (progress) => {
              entry.downloadedBytes = progress.downloadedBytes;
              entry.totalBytes = progress.totalBytes || model.sizeBytes;
              // Signals are invalidations, not a data channel: one per second
              // is enough for a progress bar and keeps the socket quiet.
              const now = Date.now();
              if (now - lastSignal < 1000) return;
              lastSignal = now;
              void context.experimental_emitSignal("changed", {
                reason: "download",
                modelId,
              });
            },
            controller.signal,
          );
        } catch (cause) {
          downloadErrors.set(
            modelId,
            controller.signal.aborted
              ? "Download cancelled."
              : cause instanceof Error
                ? cause.message
                : String(cause),
          );
        } finally {
          downloads.delete(modelId);
          lease.dispose();
          await context.experimental_emitSignal("changed", {
            reason: downloadErrors.has(modelId) ? "error" : "download",
            modelId,
          });
        }
      })();
      void directory;
      return { started: true };
    },

    // ─── Voices ────────────────────────────────────────────────────────────

    downloadVoice: async ({ modelId }, context) => {
      useDataDir(context.experimental_paths.dataDir);
      if (voiceInstalls.has(modelId)) return { started: false };
      const model = getTtsModel(modelId);

      const controller = new AbortController();
      const entry: VoiceInstall = {
        controller,
        phase: "download",
        bytes: 0,
        totalBytes: model.sizeBytes,
      };
      voiceInstalls.set(modelId, entry);
      voiceErrors.delete(modelId);

      const lease = context.experimental_retainWorker();
      void (async () => {
        let lastSignal = 0;
        try {
          await ensureTtsModelInstalled(modelId, {
            signal: controller.signal,
            onProgress: (progress: TtsInstallProgress) => {
              entry.phase = progress.phase;
              entry.bytes = progress.bytes ?? 0;
              entry.totalBytes = progress.totalBytes ?? model.sizeBytes;
              const now = Date.now();
              if (now - lastSignal < 1000) return;
              lastSignal = now;
              void context.experimental_emitSignal("changed", {
                reason: "download",
                modelId,
              });
            },
          });
        } catch (cause) {
          voiceErrors.set(
            modelId,
            controller.signal.aborted
              ? "Download cancelled."
              : cause instanceof Error
                ? cause.message
                : String(cause),
          );
        } finally {
          voiceInstalls.delete(modelId);
          lease.dispose();
          await context.experimental_emitSignal("changed", {
            reason: voiceErrors.has(modelId) ? "error" : "download",
            modelId,
          });
        }
      })();
      return { started: true };
    },

    cancelVoiceDownload: async ({ modelId }) => {
      const running = voiceInstalls.get(modelId);
      if (running === undefined) return { cancelled: false };
      running.controller.abort();
      return { cancelled: true };
    },

    deleteVoice: async ({ modelId }, context) => {
      useDataDir(context.experimental_paths.dataDir);
      voiceInstalls.get(modelId)?.controller.abort();
      clearTtsCache();
      // Only our own copy is ever removed; a voice borrowed from pi-listen
      // belongs to pi-listen.
      const own = getTtsModelDir(modelId);
      const deleted = existsSync(own);
      if (deleted) rmSync(own, { recursive: true, force: true });
      await context.experimental_emitSignal("changed", {
        reason: "download",
        modelId,
      });
      return { deleted };
    },

    speak: async ({ text, modelId, sid }, context) => {
      const directory = useDataDir(context.experimental_paths.dataDir);
      const started = Date.now();
      const config = readConfig(directory);
      const model = getTtsModel(modelId ?? config.voiceModel);

      if (!(await loadSherpa(directory))) {
        throw new Error(
          "The speech runtime is not installed. Install it on the Listen settings page.",
        );
      }
      // Refuse a language the voice cannot say before downloading anything:
      // checking afterwards fetched 36 MB and then rejected the voice.
      resolveLanguageForLocal(model, config.language);

      // Fetch the voice on first use rather than refusing.
      //
      // Someone who just switched "read answers aloud" on has not been told
      // that a voice is a separate download, and an error where they expected
      // sound reads as a broken feature. The default voice is 25 MB and the
      // wait lands on the first answer only; every later one finds it here.
      let modelDir = resolveTtsModelDir(model.id);
      if (modelDir === null) {
        if (model.incompatible !== undefined) {
          throw new Error(`The voice "${model.name}" cannot be used: ${model.incompatible}`);
        }
        const lease = context.experimental_retainWorker();
        try {
          await ensureTtsModelInstalled(model.id, { signal: context.signal });
        } catch (cause) {
          throw new Error(
            `Could not install the voice "${model.name}": ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        } finally {
          lease.dispose();
        }
        modelDir = resolveTtsModelDir(model.id);
        if (modelDir === null) {
          throw new Error(
            `The voice "${model.name}" installed but its files are not where they should be.`,
          );
        }
        await context.experimental_emitSignal("changed", {
          reason: "download",
          modelId: model.id,
        });
      }

      const runtime = probeRuntime(directory);
      if (runtime.root === null) {
        throw new Error("The speech runtime is not installed.");
      }

      const out = join(tmpdir(), `listen-${randomUUID()}.wav`);
      try {
        const { sampleRate } = await synthesizeInProcess({
          dataDir: directory,
          runtimeRoot: runtime.root,
          config: buildTtsConfig(model, modelDir),
          // Two voices can share an id across directories (ours and
          // pi-listen's), so the directory is part of the key.
          cacheKey: `${model.id}|${modelDir}`,
          text,
          sid: sid ?? config.voiceSid,
          speed: config.voiceSpeed,
          fallbackSampleRate: model.sampleRate,
          out,
          signal: context.signal,
        });
        return {
          wavBase64: readFileSync(out).toString("base64"),
          sampleRate,
          milliseconds: Date.now() - started,
        };
      } catch (cause) {
        // sherpa reports failures as a bare sentence. Name the voice and
        // where it was read from, or the user is left with "TTS settlement
        // failed" and nothing to act on.
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `${message} (voice ${model.id}, sid ${sid ?? config.voiceSid}, from ${modelDir})`,
        );
      } finally {
        rmSync(out, { force: true });
      }
    },

    cancelDownload: async ({ modelId }) => {
      const running = downloads.get(modelId);
      if (running === undefined) return { cancelled: false };
      running.controller.abort();
      return { cancelled: true };
    },

    deleteModel: async ({ modelId }, context) => {
      useDataDir(context.experimental_paths.dataDir);
      const running = downloads.get(modelId);
      running?.controller.abort();
      // The recognizer holds open file handles for whatever it loaded last.
      clearRecognizerCache();
      const deleted = deleteModelFiles(modelId);
      await context.experimental_emitSignal("changed", {
        reason: "download",
        modelId,
      });
      return { deleted };
    },
  },

  dispose: async () => {
    for (const running of downloads.values()) running.controller.abort();
    downloads.clear();
    clearRecognizerCache();
    stopSynthesis();
  },
});
