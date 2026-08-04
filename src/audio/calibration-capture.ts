import { getBasePath } from "@/base-path";

export interface CalibrationCapture {
  samples: Float32Array;
  sampleRate: number;
  startedAt: number;
}

const WORKLET_HANDSHAKE_TIMEOUT_MS = 1_500;

function waitForWorkletSignal<T>(
  signal: Promise<T>,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(message)),
      WORKLET_HANDSHAKE_TIMEOUT_MS,
    );
    void signal.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function captureCalibrationAudio(
  stream: MediaStream,
  durationSec: number,
  clock: AudioContext,
  onStarted: () => void,
): Promise<CalibrationCapture> {
  const pcm = await captureViaPcm(stream, durationSec, clock, onStarted);
  if (pcm) return pcm;
  return captureViaMediaRecorder(stream, durationSec, clock, onStarted);
}

async function captureViaPcm(
  stream: MediaStream,
  durationSec: number,
  clock: AudioContext,
  onStarted: () => void,
): Promise<CalibrationCapture | null> {
  if (typeof AudioWorkletNode === "undefined" || !clock.audioWorklet) {
    return null;
  }

  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let captureStarted = false;
  try {
    await clock.audioWorklet.addModule(
      `${getBasePath()}/worklets/pcm-recorder.js`,
    );
    source = clock.createMediaStreamSource(stream);
    node = new AudioWorkletNode(clock, "cypher-pcm-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    sink = clock.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink).connect(clock.destination);

    const chunks: Float32Array[] = [];
    let resolveStarted: (frame: number) => void = () => {};
    let rejectStarted: (error: Error) => void = () => {};
    const started = new Promise<number>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    let resolveStopped = () => {};
    let rejectStopped: (error: Error) => void = () => {};
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    node.port.onmessage = (
      event: MessageEvent<
        | { type: "chunk"; channels: ArrayBuffer[] }
        | { type: "started"; frame?: number }
        | { type: "stopped" }
      >,
    ) => {
      if (event.data.type === "chunk") {
        const channel = event.data.channels[0];
        if (channel) chunks.push(new Float32Array(channel));
      } else if (event.data.type === "started") {
        resolveStarted(
          event.data.frame ?? Math.round(clock.currentTime * clock.sampleRate),
        );
      } else if (event.data.type === "stopped") {
        resolveStopped();
      }
    };
    node.addEventListener(
      "processorerror",
      () => {
        const error = new Error("PCM calibration capture stopped unexpectedly");
        if (captureStarted) rejectStopped(error);
        else rejectStarted(error);
      },
      { once: true },
    );

    node.port.postMessage({ type: "start" });
    const startedFrame = await waitForWorkletSignal(
      started,
      "PCM calibration did not start",
    );
    captureStarted = true;
    const startedAt = startedFrame / clock.sampleRate;
    onStarted();
    await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
    node.port.postMessage({ type: "stop" });
    await waitForWorkletSignal(stopped, "PCM calibration did not stop");

    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (length === 0) {
      throw new Error("PCM calibration captured no audio");
    }
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return { samples, sampleRate: clock.sampleRate, startedAt };
  } catch (error) {
    // Failure before the processor acknowledges start is a capability failure;
    // retain the encoded route for browsers with incomplete worklet support.
    if (!captureStarted) return null;
    throw error;
  } finally {
    try {
      source?.disconnect();
      node?.disconnect();
      node?.port.close();
      sink?.disconnect();
    } catch {
      // ignore cleanup failures from a partially constructed graph
    }
  }
}

async function captureViaMediaRecorder(
  stream: MediaStream,
  durationSec: number,
  clock: AudioContext,
  onStarted: () => void,
): Promise<CalibrationCapture> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error(
      "This browser supports neither PCM capture nor MediaRecorder calibration",
    );
  }
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/aac",
  ];
  const mime = types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
  const recorder = new MediaRecorder(
    stream,
    mime ? { mimeType: mime } : undefined,
  );
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data?.size > 0) chunks.push(event.data);
  };
  const startedAt = clock.currentTime;
  // Avoid timeslices: concatenated MP4 fragments are not reliably decodable
  // on Safari.
  recorder.start();
  onStarted();
  await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.stop();
  });
  const blob = new Blob(chunks, { type: recorder.mimeType || mime });
  const context = new AudioContext();
  try {
    const encoded = await blob.arrayBuffer();
    const buffer = await context.decodeAudioData(encoded);
    return {
      samples: new Float32Array(buffer.getChannelData(0)),
      sampleRate: buffer.sampleRate,
      startedAt,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
