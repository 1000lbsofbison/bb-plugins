/**
 * Turning whatever BB recorded into what sherpa-onnx accepts.
 *
 * BB hands a plugin the composer recording as base64 plus a MIME type, and
 * does not promise a format: the renderer's MediaRecorder decides, which in
 * Chromium means WebM/Opus, while a WAV can arrive from other callers. The
 * recognizers below it want one thing only — 16 kHz mono signed 16-bit PCM.
 *
 * WAV is decoded here, in process, because that path must work on a machine
 * with nothing installed. Everything else is handed to ffmpeg, which is the
 * only realistic decoder for Opus and friends; when it is missing the caller
 * gets a sentence naming it rather than a codec error.
 */

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";

/** What the sherpa recognizers are configured for. Not negotiable. */
export const TARGET_SAMPLE_RATE = 16_000;

export class AudioDecodeError extends Error {
  /** True when the fix is "install ffmpeg", which the UI says out loud. */
  readonly needsFfmpeg: boolean;
  constructor(message: string, needsFfmpeg = false) {
    super(message);
    this.name = "AudioDecodeError";
    this.needsFfmpeg = needsFfmpeg;
  }
}

/**
 * Decode recorded audio to 16 kHz mono PCM.
 *
 * The MIME type is treated as a hint, not a fact: callers have been known to
 * label a WAV `application/octet-stream`, so the RIFF header decides.
 */
export async function decodeToPcm16k(
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (audio.length === 0) {
    throw new AudioDecodeError("The recording is empty.");
  }
  if (looksLikeWav(audio)) return decodeWav(audio);
  return decodeWithFfmpeg(audio, mimeType, signal);
}

function looksLikeWav(audio: Buffer): boolean {
  return (
    audio.length >= 12 &&
    audio.toString("ascii", 0, 4) === "RIFF" &&
    audio.toString("ascii", 8, 12) === "WAVE"
  );
}

// ─── WAV ────────────────────────────────────────────────────────────────────

interface WavData {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Read a PCM or IEEE-float WAV. Chunks are walked rather than assumed at fixed
 * offsets, because recorders routinely insert LIST or fact chunks before the
 * data.
 */
function decodeWav(audio: Buffer): Buffer {
  const { samples, sampleRate } = readWav(audio);
  return floatToPcm16(resample(samples, sampleRate, TARGET_SAMPLE_RATE));
}

function readWav(audio: Buffer): WavData {
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = audio.readUInt16LE(body);
      channels = audio.readUInt16LE(body + 2);
      sampleRate = audio.readUInt32LE(body + 4);
      bitsPerSample = audio.readUInt16LE(body + 14);
    } else if (id === "data") {
      // A streamed WAV can carry a placeholder length; trust the buffer.
      data = audio.subarray(body, Math.min(body + size, audio.length));
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (data === null || sampleRate === 0 || channels === 0) {
    throw new AudioDecodeError("The WAV recording has no readable audio data.");
  }
  // 1 = PCM, 3 = IEEE float, 0xFFFE = extensible (PCM in practice here).
  if (format !== 1 && format !== 3 && format !== 0xfffe) {
    throw new AudioDecodeError(
      `This WAV uses compressed format ${format}, which needs ffmpeg to decode.`,
      true,
    );
  }

  return { samples: toMonoFloat(data, format, bitsPerSample, channels), sampleRate };
}

/** Interleaved frames of any common width to mono float in [-1, 1]. */
function toMonoFloat(
  data: Buffer,
  format: number,
  bitsPerSample: number,
  channels: number,
): Float32Array {
  const bytes = bitsPerSample / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const mono = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const at = (frame * channels + channel) * bytes;
      sum += readSample(data, at, format, bitsPerSample);
    }
    mono[frame] = sum / channels;
  }
  return mono;
}

function readSample(
  data: Buffer,
  at: number,
  format: number,
  bitsPerSample: number,
): number {
  if (format === 3) {
    return bitsPerSample === 64 ? data.readDoubleLE(at) : data.readFloatLE(at);
  }
  switch (bitsPerSample) {
    // 8-bit WAV is unsigned with 128 as silence; every wider width is signed.
    case 8:
      return (data.readUInt8(at) - 128) / 128;
    case 16:
      return data.readInt16LE(at) / 32_768;
    case 24: {
      const raw =
        data.readUInt8(at) | (data.readUInt8(at + 1) << 8) | (data.readInt8(at + 2) << 16);
      return raw / 8_388_608;
    }
    case 32:
      return data.readInt32LE(at) / 2_147_483_648;
    default:
      throw new AudioDecodeError(
        `This WAV stores ${bitsPerSample}-bit samples, which ffmpeg can convert.`,
        true,
      );
  }
}

/**
 * Linear resampling. Speech recognition features are computed from a mel
 * spectrogram whose bands are far wider than the error a linear kernel adds,
 * so the extra cost of a windowed-sinc filter buys nothing measurable here.
 */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    out[i] = samples[left]! * (1 - fraction) + samples[right]! * fraction;
  }
  return out;
}

function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample slightly past 1.0 would wrap to silence.
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  }
  return out;
}

// ─── Everything else ────────────────────────────────────────────────────────

async function decodeWithFfmpeg(
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-i", "pipe:0",
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "-ac", "1",
        "-ar", String(TARGET_SAMPLE_RATE),
        "pipe:1",
      ],
      { signal, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new AudioDecodeError(
              missing
                ? `Decoding ${mimeType} recordings needs ffmpeg, which is not on PATH. Install it (macOS: brew install ffmpeg) and try again.`
                : `ffmpeg could not decode this ${mimeType} recording: ${stderr.toString().trim() || error.message}`,
              missing,
            ),
          );
          return;
        }
        if (stdout.length === 0) {
          reject(new AudioDecodeError("The recording decoded to no audio."));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(audio);
  });
}

/** Whether ffmpeg is available, for the setup page's dependency list. */
export async function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], (error) => resolve(error === null));
  });
}

// ─── WAV output, for speech synthesis ───────────────────────────────────────

/** Wrap mono float samples in a 16-bit WAV so a browser can play them. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const pcm = floatToPcm16(samples);
  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
