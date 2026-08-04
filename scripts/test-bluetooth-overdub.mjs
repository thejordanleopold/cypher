import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.CYPHER_URL ?? "http://localhost:3000";
const outputDir = path.resolve("output/playwright");
const reportPath = path.join(outputDir, "bluetooth-overdub-report.json");
const wavPath = path.join(outputDir, "bluetooth-overdub-capture.wav");

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  channel: process.env.CYPHER_BROWSER_CHANNEL ?? "chrome",
  headless: process.env.CYPHER_HEADLESS === "1",
  args: ["--use-fake-ui-for-media-stream"],
});

try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const durationSec = 6;
    const requestedConstraints = {
      echoCancellation: { exact: false },
      noiseSuppression: { exact: false },
      autoGainControl: { exact: false },
      sampleRate: { ideal: 48_000 },
      channelCount: { ideal: 2 },
    };

    // Granting permission once makes device labels available. Prefer the
    // AirPods input explicitly so this test cannot silently use another mic.
    const permissionProbe = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionProbe.getTracks().forEach((track) => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const airPods =
      inputs.find(
        (device) => device.deviceId !== "default" && /airpods/i.test(device.label),
      ) ?? inputs.find((device) => /airpods/i.test(device.label));
    if (!airPods) {
      throw new Error(
        `No AirPods microphone is visible to Chrome. Inputs: ${inputs
          .map((device) => device.label || "unlabelled")
          .join(", ")}`,
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...requestedConstraints, deviceId: { exact: airPods.deviceId } },
    });
    const track = stream.getAudioTracks()[0];
    const initialSettings = track.getSettings();
    const capabilities = track.getCapabilities?.() ?? {};
    const targetRate = Math.max(capabilities.sampleRate?.max ?? 0, 48_000);
    const targetChannels = Math.min(2, capabilities.channelCount?.max ?? 2);
    let maximumConstraintResult = "exact";
    try {
      await track.applyConstraints({
        sampleRate: { exact: targetRate },
        channelCount: { exact: targetChannels },
      });
    } catch {
      maximumConstraintResult = "ideal";
      try {
        await track.applyConstraints({
          sampleRate: { ideal: targetRate },
          channelCount: { ideal: targetChannels },
        });
      } catch {
        maximumConstraintResult = "unchanged";
      }
    }
    const audioContext = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
    await audioContext.resume();

    await audioContext.audioWorklet.addModule("/worklets/pcm-recorder.js");
    const source = audioContext.createMediaStreamSource(stream);
    const recorder = new AudioWorkletNode(audioContext, "cypher-pcm-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silentSink = audioContext.createGain();
    silentSink.gain.value = 0;
    source.connect(recorder).connect(silentSink).connect(audioContext.destination);

    const chunks = [];
    let resolveStopped;
    const stopped = new Promise((resolve) => {
      resolveStopped = resolve;
    });
    recorder.port.onmessage = (event) => {
      if (event.data.type === "chunk") {
        chunks.push(new Float32Array(event.data.channels[0]));
      } else if (event.data.type === "stopped") {
        resolveStopped();
      }
    };

    // Deterministic two-channel instrumental: four chord changes, bass,
    // percussion, and a quiet high-frequency texture. It is complex enough
    // that normalized correlation can distinguish real backing-track bleed
    // from speech and room noise.
    const frameCount = Math.ceil(durationSec * audioContext.sampleRate);
    const backing = audioContext.createBuffer(2, frameCount, audioContext.sampleRate);
    const monoReference = new Float32Array(frameCount);
    const progressions = [
      [110, 220, 277.18, 329.63],
      [87.31, 174.61, 220, 261.63],
      [130.81, 196, 261.63, 329.63],
      [98, 196, 246.94, 293.66],
    ];
    let seed = 0x43595048;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let channel = 0; channel < 2; channel++) {
      const data = backing.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        const time = i / audioContext.sampleRate;
        const chord = progressions[Math.min(3, Math.floor(time / 1.5))];
        let sample = 0;
        for (let tone = 0; tone < chord.length; tone++) {
          const panPhase = channel === 0 ? tone * 0.17 : tone * -0.13;
          sample += Math.sin(2 * Math.PI * chord[tone] * time + panPhase) * 0.042;
        }
        const beatPhase = time % 0.5;
        if (beatPhase < 0.035) {
          const envelope = 1 - beatPhase / 0.035;
          sample += (random() * 2 - 1) * envelope * 0.12;
        }
        sample += Math.sin(2 * Math.PI * 6200 * time) * 0.008;
        data[i] = sample;
        monoReference[i] += sample * 0.5;
      }
    }

    const backingSource = audioContext.createBufferSource();
    backingSource.buffer = backing;
    const backingGain = audioContext.createGain();
    backingGain.gain.value = 0.85;
    backingSource.connect(backingGain).connect(audioContext.destination);

    recorder.port.postMessage({ type: "start" });
    const startsAt = audioContext.currentTime + 0.25;
    backingSource.start(startsAt);
    await new Promise((resolve) => setTimeout(resolve, (durationSec + 0.7) * 1000));
    recorder.port.postMessage({ type: "stop" });
    await stopped;

    const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(sampleCount);
    let writeOffset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }

    let sumSquares = 0;
    let peak = 0;
    let clipped = 0;
    for (const sample of samples) {
      const absolute = Math.abs(sample);
      sumSquares += sample * sample;
      peak = Math.max(peak, absolute);
      if (absolute >= 0.999) clipped++;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
    const toDbfs = (amplitude) =>
      amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;

    // Cross-correlate at 2 kHz. Skip the 250 ms scheduled lead and search up
    // to 750 ms of acoustic/Bluetooth latency. A high normalized result means
    // the instrumental is leaking into the microphone recording.
    const stride = Math.max(1, Math.round(audioContext.sampleRate / 2000));
    const mic = [];
    const ref = [];
    for (let i = 0; i < samples.length; i += stride) mic.push(samples[i]);
    for (let i = 0; i < monoReference.length; i += stride) ref.push(monoReference[i]);
    const scheduledLead = Math.round((0.25 * audioContext.sampleRate) / stride);
    const maxLag = Math.round((0.75 * audioContext.sampleRate) / stride);
    let maxCorrelation = 0;
    let bestLag = 0;
    for (let lag = scheduledLead; lag <= scheduledLead + maxLag; lag += 2) {
      const count = Math.min(ref.length, mic.length - lag);
      if (count <= 0) continue;
      let dot = 0;
      let micEnergy = 0;
      let refEnergy = 0;
      for (let i = 0; i < count; i++) {
        const micValue = mic[i + lag];
        const refValue = ref[i];
        dot += micValue * refValue;
        micEnergy += micValue * micValue;
        refEnergy += refValue * refValue;
      }
      const correlation = Math.abs(dot) / Math.sqrt(micEnergy * refEnergy || 1);
      if (correlation > maxCorrelation) {
        maxCorrelation = correlation;
        bestLag = lag;
      }
    }

    const settings = track.getSettings();
    const constraints = track.getConstraints();
    const report = {
      device: { label: track.label, deviceId: settings.deviceId },
      initialSettings,
      settings,
      capabilities,
      constraints,
      maximumConstraintResult,
      audioContextSampleRate: audioContext.sampleRate,
      durationSec: samples.length / audioContext.sampleRate,
      rmsDbfs: toDbfs(rms),
      peakDbfs: toDbfs(peak),
      clippedSamplePercent: (clipped / Math.max(1, samples.length)) * 100,
      backingCorrelation: maxCorrelation,
      estimatedBleedLatencyMs:
        maxCorrelation >= 0.08
          ? (bestLag * stride * 1000) / audioContext.sampleRate
          : null,
      checks: {
        selectedAirPodsMic: /airpods/i.test(track.label),
        browserDspDisabled:
          settings.echoCancellation === false &&
          settings.noiseSuppression === false &&
          settings.autoGainControl === false,
        noClipping: clipped / Math.max(1, samples.length) < 0.001,
        backingIsolation: maxCorrelation < 0.15,
        fullBandwidthInput:
          settings.sampleRate >= 44_100 && settings.channelCount >= 1,
      },
    };

    stream.getTracks().forEach((streamTrack) => streamTrack.stop());
    recorder.disconnect();
    silentSink.disconnect();
    backingSource.disconnect();
    backingGain.disconnect();
    await audioContext.close();

    return { report, samples: Array.from(samples) };
  });

  const samples = Float32Array.from(result.samples);
  const sampleRate = result.report.audioContextSampleRate;
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(Math.round(clamped * (clamped < 0 ? 32768 : 32767)), 44 + i * 2);
  }

  await fs.writeFile(wavPath, wav);
  await fs.writeFile(reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
  console.log(JSON.stringify({ ...result.report, artifacts: { reportPath, wavPath } }, null, 2));
} finally {
  await Promise.race([
    browser.close(),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

// Chrome can occasionally leave its automation pipe open after a live Core
// Audio stream is closed. The report and WAV are already flushed at this
// point, so do not make a successful hardware test hang indefinitely.
process.exit(0);
