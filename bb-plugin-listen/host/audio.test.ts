/**
 * Tests for the audio gate.
 *
 * These are the paths where a mistake is silent: a WAV parsed at the wrong
 * offset yields noise, not an error, and the recognizer answers with plausible
 * nonsense. So each case asserts on what the samples actually are.
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  AudioDecodeError,
  TARGET_SAMPLE_RATE,
  decodeToPcm16k,
  encodeWav,
} from "./audio";

/** Build a WAV by hand so the parser is tested against bytes, not itself. */
function wav(options: {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format?: number;
  samples: number[][];
  extraChunk?: boolean;
}): Buffer {
  const { sampleRate, channels, bitsPerSample, format = 1, samples } = options;
  const bytes = bitsPerSample / 8;
  const data = Buffer.alloc(samples.length * channels * bytes);
  samples.forEach((frame, index) => {
    frame.forEach((value, channel) => {
      const at = (index * channels + channel) * bytes;
      if (format === 3) data.writeFloatLE(value, at);
      else if (bitsPerSample === 8) data.writeUInt8(Math.round(value * 128 + 128), at);
      else if (bitsPerSample === 16) data.writeInt16LE(Math.round(value * 32767), at);
      else data.writeInt32LE(Math.round(value * 2147483647), at);
    });
  });

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bitsPerSample, 22);

  // A LIST chunk before the data, which recorders really do emit — the parser
  // has to walk chunks rather than assume data sits at a fixed offset.
  const extra = Buffer.alloc(options.extraChunk === true ? 12 : 0);
  if (options.extraChunk === true) {
    extra.write("LIST", 0, "ascii");
    extra.writeUInt32LE(4, 4);
    extra.write("INFO", 8, "ascii");
  }

  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + fmt.length + extra.length + 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");

  const dataChunk = Buffer.alloc(8);
  dataChunk.write("data", 0, "ascii");
  dataChunk.writeUInt32LE(data.length, 4);

  return Buffer.concat([header, fmt, extra, dataChunk, data]);
}

function readPcm(buffer: Buffer): number[] {
  const out: number[] = [];
  for (let at = 0; at + 1 < buffer.length; at += 2) out.push(buffer.readInt16LE(at));
  return out;
}

describe("decodeToPcm16k", () => {
  it("keeps the samples of a 16 kHz mono recording", async () => {
    const source = [[0], [0.5], [-0.5], [1]];
    const pcm = await decodeToPcm16k(
      wav({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitsPerSample: 16, samples: source }),
      "audio/wav",
    );
    // 0.5 scales to 16384 and full scale loses one step, because reading
    // divides by 32768 while writing multiplies by 32767.
    expect(readPcm(pcm)).toEqual([0, 16384, -16383, 32766]);
  });

  it("finds the audio behind a chunk it does not know", async () => {
    const pcm = await decodeToPcm16k(
      wav({
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        samples: [[0.5], [0.5]],
        extraChunk: true,
      }),
      "audio/wav",
    );
    // Without chunk walking this would read the LIST bytes as audio.
    expect(readPcm(pcm)).toEqual([16384, 16384]);
  });

  it("mixes stereo down to one channel", async () => {
    const pcm = await decodeToPcm16k(
      wav({
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 2,
        bitsPerSample: 16,
        samples: [
          [1, -1],
          [0.5, 0.5],
        ],
      }),
      "audio/wav",
    );
    expect(readPcm(pcm)).toEqual([0, 16384]);
  });

  it("halves the sample count when resampling 32 kHz down to 16", async () => {
    const samples = Array.from({ length: 64 }, () => [0.25]);
    const pcm = await decodeToPcm16k(
      wav({ sampleRate: 32_000, channels: 1, bitsPerSample: 16, samples }),
      "audio/wav",
    );
    expect(readPcm(pcm)).toHaveLength(32);
    // A constant signal must stay constant through the resampler.
    expect(new Set(readPcm(pcm))).toEqual(new Set([8192]));
  });

  it("reads 8-bit WAVs as unsigned, where 128 is silence", async () => {
    const pcm = await decodeToPcm16k(
      wav({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitsPerSample: 8, samples: [[0]] }),
      "audio/wav",
    );
    expect(readPcm(pcm)).toEqual([0]);
  });

  it("reads float WAVs", async () => {
    const pcm = await decodeToPcm16k(
      wav({
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 32,
        format: 3,
        samples: [[0.5]],
      }),
      "audio/wav",
    );
    expect(readPcm(pcm)).toEqual([16384]);
  });

  it("clamps rather than wrapping when a float sample exceeds full scale", async () => {
    const pcm = await decodeToPcm16k(
      wav({
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 32,
        format: 3,
        samples: [[1.5], [-1.5]],
      }),
      "audio/wav",
    );
    // Without the clamp these wrap through zero and the audio clicks.
    expect(readPcm(pcm)).toEqual([32767, -32767]);
  });

  it("refuses an empty recording", async () => {
    await expect(decodeToPcm16k(Buffer.alloc(0), "audio/wav")).rejects.toThrow(
      AudioDecodeError,
    );
  });

  it("refuses a WAV with a header but no audio", async () => {
    await expect(
      decodeToPcm16k(Buffer.from("RIFF\0\0\0\0WAVE", "ascii"), "audio/wav"),
    ).rejects.toThrow(/no readable audio/i);
  });

  it("names ffmpeg when a WAV turns out to be compressed", async () => {
    const compressed = wav({
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      format: 0x11, // IMA ADPCM
      samples: [[0.5]],
    });
    await expect(decodeToPcm16k(compressed, "audio/wav")).rejects.toMatchObject({
      needsFfmpeg: true,
    });
  });
});

describe("encodeWav", () => {
  it("writes a header a decoder reads back unchanged", async () => {
    const original = Float32Array.from([0, 0.5, -0.5]);
    const encoded = encodeWav(original, TARGET_SAMPLE_RATE);

    expect(encoded.toString("ascii", 0, 4)).toBe("RIFF");
    expect(encoded.readUInt32LE(24)).toBe(TARGET_SAMPLE_RATE);
    expect(encoded.readUInt16LE(22)).toBe(1);

    const roundTrip = await decodeToPcm16k(encoded, "audio/wav");
    expect(readPcm(roundTrip)).toEqual([0, 16384, -16383]);
  });
});
