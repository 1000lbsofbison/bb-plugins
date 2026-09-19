/**
 * Synthesis in a separate, resident Node process.
 *
 * Two reasons it is not done in the host worker:
 *
 * 1. sherpa returns generated audio as an externally-backed Float32Array, and
 *    the BB host worker refuses those — every synthesis ends as "External
 *    buffers are not allowed", or on the async path as the native "TTS
 *    settlement failed". Recognition never hit this because it returns a
 *    string. BB's own binary is Electron, and Electron's V8 rejects them even
 *    with ELECTRON_RUN_AS_NODE set, so a real `node` has to do the work.
 * 2. Loading a voice costs most of the time a synthesis takes — measured on
 *    an M-series machine: a fresh process needs 0.8 s for a short German
 *    sentence with a 16 kHz voice and 3.5 s with the high-quality one, and
 *    almost all of that is the model load.
 *
 * So one child stays alive and keeps its loaded voices, answering one JSON
 * line per request. It stops itself after a few idle minutes; the next
 * request starts a fresh one. Audio crosses the boundary as a WAV file,
 * which nothing objects to.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";

/**
 * The child. Reads one JSON request per line on stdin, writes one JSON reply
 * per line on stdout, and puts the audio in a file. CommonJS so it runs under
 * any Node on the machine, without a package.json beside it.
 *
 * Voices are cached by model directory: the whole point of keeping this
 * process alive.
 */
const SCRIPT = `"use strict";
const fs = require("node:fs");
const readline = require("node:readline");

function encodeWav(samples, sampleRate) {
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const voices = new Map();

async function voiceFor(request) {
  const cached = voices.get(request.cacheKey);
  if (cached !== undefined) return cached;
  const loaded = require(request.runtimePackage);
  const sherpa = typeof loaded.OfflineTts === "function" ? loaded : loaded.default;
  const tts = await sherpa.OfflineTts.createAsync(request.config);
  voices.set(request.cacheKey, tts);
  return tts;
}

// Requests are handled one at a time. sherpa's generate is not documented as
// re-entrant per instance, and two answers spoken at once would be useless
// anyway.
let queue = Promise.resolve();

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  queue = queue.then(async () => {
    let id = null;
    try {
      const request = JSON.parse(line);
      id = request.id;
      const tts = await voiceFor(request);
      const audio = await tts.generateAsync({
        text: request.text, sid: request.sid, speed: request.speed,
      });
      const samples = audio.samples;
      if (samples.length > 0 && Number.isNaN(samples[0])) {
        throw new Error("the voice produced silence (all-NaN samples); it is not compatible with this runtime");
      }
      const sampleRate = audio.sampleRate || tts.sampleRate || request.fallbackSampleRate;
      fs.writeFileSync(request.out, encodeWav(samples, sampleRate));
      process.stdout.write(JSON.stringify({ id, ok: true, sampleRate }) + "\\n");
    } catch (cause) {
      const message = (cause && cause.message ? cause.message : String(cause)) + " [node " + process.version + "]";
      process.stdout.write(JSON.stringify({ id, ok: false, message }) + "\\n");
    }
  });
});

process.stdin.on("end", () => process.exit(0));
`;

/** Write the child script once per data directory and return its path. */
function ensureScript(dataDir: string): string {
  const path = join(dataDir, "synthesize.cjs");
  // Rewritten when the content differs so a plugin update is picked up
  // without the user clearing anything.
  if (!existsSync(path) || readFileSync(path, "utf8") !== SCRIPT) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, SCRIPT);
  }
  return path;
}

/**
 * Locate a real Node.
 *
 * `process.execPath` is not usable: under BB the host worker runs from the
 * Electron binary. Well-known install locations are searched after PATH,
 * because a daemon's PATH often lacks the shell's additions.
 */
export function findNode(): string | null {
  // `path.delimiter` rather than ":" — Windows separates PATH with ";", and
  // splitting on a colon there turns "C:\\Program Files" into two bogus
  // entries.
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const candidates: string[] = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory !== "") candidates.push(join(directory, executable));
  }
  // Where installers put it when the daemon's PATH is the bare system one.
  candidates.push(
    ...(process.platform === "win32"
      ? ["C:\\Program Files\\nodejs\\node.exe"]
      : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]),
  );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not there, or not executable by us — keep looking.
    }
  }
  return null;
}

export interface SynthRequest {
  dataDir: string;
  /** Directory whose node_modules holds sherpa-onnx-node. */
  runtimeRoot: string;
  /** The sherpa config for this voice, already assembled. */
  config: unknown;
  /** Identifies the loaded voice in the child's cache. */
  cacheKey: string;
  text: string;
  sid: number;
  speed: number;
  fallbackSampleRate: number;
  /** Where the child writes the WAV. */
  out: string;
  signal?: AbortSignal;
}

/** How long the child may sit idle before it is stopped. */
const IDLE_MS = 5 * 60 * 1000;

interface Pending {
  resolve: (value: { sampleRate: number }) => void;
  reject: (cause: Error) => void;
}

let child: ChildProcessWithoutNullStreams | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function stopChild(reason: string): void {
  const dying = child;
  child = null;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  // Nothing will answer these now; failing them is better than hanging.
  for (const [, waiter] of pending) waiter.reject(new Error(reason));
  pending.clear();
  dying?.kill();
}

function touchIdleTimer(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopChild("idle");
  }, IDLE_MS);
  // Do not hold the worker open just to keep a warm voice around.
  idleTimer.unref?.();
}

function startChild(node: string, script: string): ChildProcessWithoutNullStreams {
  const started = spawn(node, [script], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";

  started.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    // One reply per line; a partial line stays in the buffer.
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim() === "") continue;

      try {
        const reply = JSON.parse(line) as
          | { id: number; ok: true; sampleRate: number }
          | { id: number; ok: false; message: string };
        const waiter = pending.get(reply.id);
        if (waiter === undefined) continue;
        pending.delete(reply.id);
        if (reply.ok) waiter.resolve({ sampleRate: reply.sampleRate });
        else waiter.reject(new Error(reply.message));
      } catch {
        // A line we cannot parse means the child is confused; a restart is
        // cheaper to reason about than guessing what it meant.
        stopChild(`The synthesis process sent something unreadable: ${line.slice(0, 120)}`);
        return;
      }
    }
  });

  let stderr = "";
  started.stderr.on("data", (chunk: Buffer) => {
    // Keep only the tail: this is for the error message, not a log.
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  started.on("error", (cause) => stopChild(`The synthesis process failed to start: ${cause.message}`));
  started.on("exit", (code) => {
    if (child === started) {
      stopChild(
        `The synthesis process exited (${code})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
      );
    }
  });
  return started;
}

/**
 * Run one synthesis. Resolves once the WAV is on disk.
 *
 * The first call after an idle period pays the model load; the ones after it
 * do not, which is the whole reason the child is kept.
 */
export async function synthesizeInProcess(
  request: SynthRequest,
): Promise<{ sampleRate: number }> {
  const node = findNode();
  if (node === null) {
    throw new Error(
      "Speaking needs Node on PATH. BB's own binary is Electron, which refuses the audio buffers sherpa produces. Install Node (macOS: brew install node) and try again.",
    );
  }

  const script = ensureScript(request.dataDir);
  // Resolve the package to an absolute path here: the child has no notion of
  // our install root, and a bare specifier would not resolve there.
  const require_ = createRequire(join(request.runtimeRoot, "package.json"));
  const runtimePackage = require_.resolve("sherpa-onnx-node");

  if (child === null) child = startChild(node, script);
  const worker = child;

  const id = nextId++;
  const payload = JSON.stringify({
    id,
    runtimePackage,
    cacheKey: request.cacheKey,
    config: request.config,
    text: request.text,
    sid: request.sid,
    speed: request.speed,
    fallbackSampleRate: request.fallbackSampleRate,
    out: request.out,
  });

  return new Promise<{ sampleRate: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });

    const onAbort = () => {
      // The child finishes the work regardless — there is no way to interrupt
      // a generate mid-flight — but the caller stops waiting for it.
      pending.delete(id);
      reject(new Error("Speaking was cancelled."));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const settle = () => {
      request.signal?.removeEventListener("abort", onAbort);
      touchIdleTimer();
    };
    pending.set(id, {
      resolve: (value) => {
        settle();
        resolve(value);
      },
      reject: (cause) => {
        settle();
        reject(cause);
      },
    });

    worker.stdin.write(`${payload}\n`);
  });
}

/** Stop the child, if one is running. For the host's dispose hook. */
export function stopSynthesis(): void {
  stopChild("The plugin is shutting down.");
}
