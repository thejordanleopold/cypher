// Recorder AudioWorklet: captures input frames and posts Float32 chunks to main.
// Mono downmix from any input channel count.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._recording = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === "start") this._recording = true;
      else if (e.data?.type === "stop") {
        this._recording = false;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  process(inputs) {
    if (!this._recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelCount = input.length;
    const frames = input[0].length;
    // Downmix to mono.
    const mono = new Float32Array(frames);
    for (let c = 0; c < channelCount; c++) {
      const ch = input[c];
      for (let i = 0; i < frames; i++) mono[i] += ch[i];
    }
    if (channelCount > 1) {
      for (let i = 0; i < frames; i++) mono[i] /= channelCount;
    }
    this.port.postMessage({ type: "chunk", data: mono }, [mono.buffer]);
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
