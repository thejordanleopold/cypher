import { getBasePath } from "@/base-path";

type SpoolerMessage =
  | { type: "ready"; storage: "opfs" | "memory" }
  | { type: "storage"; storage: "memory" }
  | { type: "metadata"; length: number; channelCount: number }
  | { type: "segment"; offset: number; channels: ArrayBuffer[] }
  | { type: "done" }
  | { type: "aborted" }
  | { type: "error"; message: string };

const WORKER_START_TIMEOUT_MS = 2_000;
const WORKER_ABORT_TIMEOUT_MS = 1_000;

export class PcmSpooler {
  private readonly worker: Worker;
  private readonly readyPromise: Promise<void>;
  private resolveReady = () => {};
  private rejectReady: (error: Error) => void = () => {};
  private finishPromise: Promise<AudioBuffer> | null = null;
  private resolveFinish: (buffer: AudioBuffer) => void = () => {};
  private rejectFinish: (error: Error) => void = () => {};
  private abortPromise: Promise<void> | null = null;
  private resolveAbort = () => {};
  private buffer: AudioBuffer | null = null;
  private sampleRate = 0;
  private fatalError: Error | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closed = false;

  private constructor() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(
      `${getBasePath()}/workers/pcm-spooler.js`,
      { name: "cypher-pcm-spooler" },
    );
    this.worker.onmessage = (event: MessageEvent<SpoolerMessage>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "PCM spool worker failed"));
    };
    this.worker.postMessage({
      type: "init",
      captureId:
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }

  static async create(): Promise<PcmSpooler> {
    const spooler = new PcmSpooler();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        spooler.readyPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("PCM spool worker did not start")),
            WORKER_START_TIMEOUT_MS,
          );
        }),
      ]);
      return spooler;
    } catch (error) {
      spooler.terminate();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  setErrorHandler(handler: ((error: Error) => void) | null) {
    this.errorHandler = handler;
    if (handler && this.fatalError) handler(this.fatalError);
  }

  push(channels: ArrayBuffer[]) {
    if (this.closed || this.fatalError || channels.length === 0) return;
    this.worker.postMessage({ type: "chunk", channels }, channels);
  }

  finish(sampleRate: number): Promise<AudioBuffer> {
    if (this.finishPromise) return this.finishPromise;
    this.sampleRate = sampleRate;
    this.finishPromise = new Promise<AudioBuffer>((resolve, reject) => {
      this.resolveFinish = resolve;
      this.rejectFinish = reject;
    });
    if (this.fatalError) {
      this.rejectFinish(this.fatalError);
    } else {
      this.worker.postMessage({ type: "finish" });
    }
    return this.finishPromise;
  }

  abort(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.abortPromise) return this.abortPromise;
    this.abortPromise = new Promise<void>((resolve) => {
      this.resolveAbort = resolve;
    });
    this.worker.postMessage({ type: "abort" });
    const timeout = setTimeout(() => {
      this.terminate();
      this.resolveAbort();
    }, WORKER_ABORT_TIMEOUT_MS);
    void this.abortPromise.finally(() => clearTimeout(timeout));
    return this.abortPromise;
  }

  private handleMessage(message: SpoolerMessage) {
    if (message.type === "ready") {
      this.resolveReady();
      return;
    }
    if (message.type === "storage") return;
    if (message.type === "error") {
      this.fail(new Error(message.message));
      return;
    }
    if (message.type === "aborted") {
      this.terminate();
      this.resolveAbort();
      return;
    }
    if (message.type === "metadata") {
      if (message.length <= 0 || message.channelCount <= 0) {
        const error = new Error("Recording captured no audio");
        error.name = "EmptyRecordingError";
        this.fail(error);
        return;
      }
      this.buffer = new AudioBuffer({
        length: message.length,
        numberOfChannels: message.channelCount,
        sampleRate: this.sampleRate,
      });
      return;
    }
    if (message.type === "segment") {
      if (!this.buffer) {
        this.fail(new Error("PCM spool worker sent audio before metadata"));
        return;
      }
      for (let channel = 0; channel < this.buffer.numberOfChannels; channel++) {
        const source = message.channels[channel] ?? message.channels[0];
        if (source) {
          this.buffer.copyToChannel(
            new Float32Array(source),
            channel,
            message.offset,
          );
        }
      }
      this.worker.postMessage({ type: "segment-ack" });
      return;
    }
    if (message.type === "done") {
      if (!this.buffer) {
        this.fail(new Error("PCM spool worker returned no audio"));
        return;
      }
      const buffer = this.buffer;
      this.terminate();
      this.resolveFinish(buffer);
    }
  }

  private fail(error: Error) {
    if (this.fatalError) return;
    this.fatalError = error;
    this.rejectReady(error);
    this.rejectFinish(error);
    this.errorHandler?.(error);
  }

  private terminate() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
  }
}
