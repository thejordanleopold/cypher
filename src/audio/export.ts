import { audioBufferToWavBlob } from "@/audio/wav";

export type ExportFormat = "wav" | "mp3";

export async function encodeBuffer(
  buffer: AudioBuffer,
  format: ExportFormat,
  onProgress?: (p: number) => void,
): Promise<Blob> {
  if (format === "wav") {
    onProgress?.(1);
    return audioBufferToWavBlob(buffer);
  }

  // MP3 via worker.
  const numChannels = Math.min(buffer.numberOfChannels, 2);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    // Copy because we transfer to the worker.
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }

  const worker = new Worker(new URL("./mp3-worker.ts", import.meta.url), {
    type: "module",
  });

  return new Promise<Blob>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "progress") onProgress?.(msg.value);
      else if (msg.type === "done") {
        onProgress?.(1);
        worker.terminate();
        resolve(msg.blob as Blob);
      } else if (msg.type === "error") {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "MP3 worker error"));
    };
    worker.postMessage(
      {
        type: "encode",
        channels,
        sampleRate: buffer.sampleRate,
        bitrate: 192,
      },
      channels.map((c) => c.buffer),
    );
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
