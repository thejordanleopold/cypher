/* global AudioWorkletProcessor, currentFrame, registerProcessor */

const CHUNK_FRAMES = 8192;

class CypherPcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.channelCount = 0;
    this.writeOffset = 0;
    this.buffers = [];
    this.port.onmessage = (event) => {
      if (event.data?.type === "start") {
        this.reset();
        this.recording = true;
        this.port.postMessage({ type: "started", frame: currentFrame });
      } else if (event.data?.type === "stop") {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  reset() {
    this.channelCount = 0;
    this.writeOffset = 0;
    this.buffers = [];
  }

  allocate(channelCount) {
    this.channelCount = channelCount;
    this.writeOffset = 0;
    this.buffers = Array.from(
      { length: channelCount },
      () => new Float32Array(CHUNK_FRAMES),
    );
  }

  flush() {
    if (this.writeOffset === 0 || this.channelCount === 0) return;
    const channels = this.buffers.map((buffer) =>
      buffer.slice(0, this.writeOffset),
    );
    this.port.postMessage(
      {
        type: "chunk",
        channels: channels.map((channel) => channel.buffer),
      },
      channels.map((channel) => channel.buffer),
    );
    this.allocate(this.channelCount);
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    const channelCount = Math.min(input?.length ?? 0, 2);
    const frames = input?.[0]?.length ?? 0;
    if (channelCount === 0 || frames === 0) return true;
    if (this.channelCount === 0) this.allocate(channelCount);

    let sourceOffset = 0;
    while (sourceOffset < frames) {
      const copyLength = Math.min(
        frames - sourceOffset,
        CHUNK_FRAMES - this.writeOffset,
      );
      for (let channel = 0; channel < this.channelCount; channel++) {
        const source = input[channel] ?? input[0];
        this.buffers[channel].set(
          source.subarray(sourceOffset, sourceOffset + copyLength),
          this.writeOffset,
        );
      }
      sourceOffset += copyLength;
      this.writeOffset += copyLength;
      if (this.writeOffset === CHUNK_FRAMES) this.flush();
    }
    return true;
  }
}

registerProcessor("cypher-pcm-recorder", CypherPcmRecorder);
