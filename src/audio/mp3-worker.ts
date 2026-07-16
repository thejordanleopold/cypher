/// <reference lib="webworker" />
// MP3 encoder worker. Receives Float32 channel data + sample rate, posts back a Blob.
// Uses lamejs (no types).
// @ts-expect-error - lamejs has no type declarations
import lamejs from "lamejs";
// lamejs@1.2.1's package entry leaves these symbols as globals even though
// its encoder modules reference them. Import and expose the package's own
// implementations before constructing Mp3Encoder.
// @ts-expect-error - lamejs has no type declarations or exported subpath types
import Lame from "lamejs/src/js/Lame.js";
// @ts-expect-error - lamejs has no type declarations or exported subpath types
import BitStream from "lamejs/src/js/BitStream.js";
// @ts-expect-error - lamejs has no type declarations or exported subpath types
import MPEGMode from "lamejs/src/js/MPEGMode.js";

Object.assign(globalThis, { BitStream, Lame, MPEGMode });

interface EncodeMessage {
  type: "encode";
  channels: Float32Array[]; // 1 (mono) or 2 (stereo) channels
  sampleRate: number;
  bitrate: number; // kbps, e.g., 192
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<EncodeMessage>) => {
  if (e.data?.type !== "encode") return;
  try {
    const { channels, sampleRate, bitrate } = e.data;
    const numChannels = Math.min(channels.length, 2);
    const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
    const sampleBlockSize = 1152;

    // Convert Float32 [-1,1] → Int16
    const left = floatToInt16(channels[0]);
    const right = numChannels === 2 ? floatToInt16(channels[1]) : null;

    const mp3Chunks: Uint8Array[] = [];
    for (let i = 0; i < left.length; i += sampleBlockSize) {
      const leftChunk = left.subarray(i, i + sampleBlockSize);
      let mp3buf;
      if (right) {
        const rightChunk = right.subarray(i, i + sampleBlockSize);
        mp3buf = encoder.encodeBuffer(leftChunk, rightChunk);
      } else {
        mp3buf = encoder.encodeBuffer(leftChunk);
      }
      if (mp3buf.length > 0) mp3Chunks.push(new Uint8Array(mp3buf));
      if (i % (sampleBlockSize * 100) === 0) {
        ctx.postMessage({ type: "progress", value: i / left.length });
      }
    }
    const flush = encoder.flush();
    if (flush.length > 0) mp3Chunks.push(new Uint8Array(flush));

    const blob = new Blob(mp3Chunks as BlobPart[], { type: "audio/mpeg" });
    ctx.postMessage({ type: "done", blob });
  } catch (err) {
    ctx.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
