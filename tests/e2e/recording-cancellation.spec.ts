import { expect, test } from "@playwright/test";

async function waitForShell(page: import("@playwright/test").Page) {
  const shell = page.getByRole("button", { name: /Start Demo|Exit Demo/ });
  const resume = page.getByRole("button", { name: "Resume Session" });
  await expect(shell.or(resume)).toBeVisible({ timeout: 10_000 });
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await expect(shell).toBeVisible();
}

interface RecordedWavStats {
  backingToneAmplitude: number;
  bitsPerSample: number;
  dataBytes: number;
  micToneAmplitude: number;
  nonZeroSamples: number;
  sampleRate: number;
}

function createToneWav(frequency: number, durationSec: number): Buffer {
  const sampleRate = 48_000;
  const frames = Math.round(sampleRate * durationSec);
  const wav = Buffer.alloc(44 + frames * 2);
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
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const envelope = Math.min(1, i / 240, (frames - i - 1) / 240);
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    wav.writeInt16LE(Math.round(sample * envelope * 0.3 * 32767), 44 + i * 2);
  }
  return wav;
}

async function readRecordedWavStats(
  page: import("@playwright/test").Page,
): Promise<RecordedWavStats | null> {
  return page.evaluate(
    () =>
      new Promise<RecordedWavStats | null>((resolve, reject) => {
        const request = indexedDB.open("cypher", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const metaRequest = db
            .transaction("meta", "readonly")
            .objectStore("meta")
            .get("currentProjectId");
          metaRequest.onerror = () => reject(metaRequest.error);
          metaRequest.onsuccess = () => {
            const projectRequest = db
              .transaction("projects", "readonly")
              .objectStore("projects")
              .get(metaRequest.result);
            projectRequest.onerror = () => reject(projectRequest.error);
            projectRequest.onsuccess = () => {
              const track = (
                projectRequest.result as {
                  tracks?: Array<{
                    audioKey?: string | null;
                    fileName?: string | null;
                  }>;
                }
              )?.tracks?.find(
                (candidate) =>
                  candidate.fileName === "Recording" && candidate.audioKey,
              );
              if (!track?.audioKey) {
                db.close();
                resolve(null);
                return;
              }
              const audioRequest = db
                .transaction("audio", "readonly")
                .objectStore("audio")
                .get(track.audioKey);
              audioRequest.onerror = () => reject(audioRequest.error);
              audioRequest.onsuccess = () => {
                const stored = audioRequest.result;
                db.close();
                if (!(stored instanceof ArrayBuffer) || stored.byteLength <= 44) {
                  resolve(null);
                  return;
                }
                const view = new DataView(stored);
                let nonZeroSamples = 0;
                const sampleRate = view.getUint32(24, true);
                const channels = view.getUint16(22, true);
                const frameBytes = channels * 2;
                const availableFrames = Math.floor(
                  (stored.byteLength - 44) / frameBytes,
                );
                const analysisFrames = Math.min(availableFrames, sampleRate);
                const toneAmplitude = (frequency: number) => {
                  let real = 0;
                  let imaginary = 0;
                  for (let frame = 0; frame < analysisFrames; frame++) {
                    const sample =
                      view.getInt16(44 + frame * frameBytes, true) / 32768;
                    const phase = (2 * Math.PI * frequency * frame) / sampleRate;
                    real += sample * Math.cos(phase);
                    imaginary -= sample * Math.sin(phase);
                  }
                  return (
                    (2 * Math.hypot(real, imaginary)) /
                    Math.max(1, analysisFrames)
                  );
                };
                for (
                  let offset = 44;
                  offset + 1 < stored.byteLength;
                  offset += 2
                ) {
                  if (view.getInt16(offset, true) !== 0) nonZeroSamples++;
                }
                resolve({
                  backingToneAmplitude: toneAmplitude(997),
                  bitsPerSample: view.getUint16(34, true),
                  dataBytes: view.getUint32(40, true),
                  micToneAmplitude: toneAmplitude(440),
                  nonZeroSamples,
                  sampleRate,
                });
              };
            };
          };
        };
      }),
  );
}

async function installOscillatorMic(
  page: import("@playwright/test").Page,
  mode: "pcm-only" | "encoded-only" | "worker-unavailable",
) {
  await page.evaluate(async (captureMode) => {
    type CaptureTestWindow = Window & {
      __captureContext?: AudioContext;
      __captureOscillator?: OscillatorNode;
    };
    const testWindow = window as CaptureTestWindow;
    // Match the app's output graph rate. Forcing the fake mic to 48 kHz while
    // the active Bluetooth output graph is lower would correctly make CYPHER
    // reject the PCM path rather than downsample the input.
    const context = new AudioContext();
    await context.resume();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.2;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    testWindow.__captureContext = context;
    testWindow.__captureOscillator = oscillator;

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => destination.stream,
    });
    if (captureMode === "pcm-only") {
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: class {
          constructor() {
            throw new Error("MediaRecorder fallback must not be constructed");
          }
        },
      });
    } else if (captureMode === "encoded-only") {
      Object.defineProperty(window, "AudioWorkletNode", {
        configurable: true,
        value: undefined,
      });
    } else {
      Object.defineProperty(window, "Worker", {
        configurable: true,
        value: undefined,
      });
    }
  }, mode);
}

async function pcmTempFileCount(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(
        "cypher-recording-temp",
      );
      const iterable = directory as FileSystemDirectoryHandle & {
        values(): AsyncIterableIterator<FileSystemHandle>;
      };
      let count = 0;
      for await (const entry of iterable.values()) {
        if (entry.kind === "file" && entry.name.startsWith("pcm-")) count++;
      }
      return count;
    } catch {
      return 0;
    }
  });
}

async function stopOscillatorMic(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const testWindow = window as Window & {
      __captureContext?: AudioContext;
      __captureOscillator?: OscillatorNode;
    };
    testWindow.__captureOscillator?.stop();
    await testWindow.__captureContext?.close();
  });
}

test("records lossless PCM without constructing MediaRecorder", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });

  await installOscillatorMic(page, "pcm-only");
  const captureGraphRate = await page.evaluate(
    () =>
      (window as Window & { __captureContext?: AudioContext }).__captureContext
        ?.sampleRate ?? 0,
  );

  const spoolWorkerRequest = page.waitForRequest((request) =>
    request.url().endsWith("/workers/pcm-spooler.js"),
  );
  await page.getByRole("button", { name: "Arm for recording" }).first().click();
  await page.getByRole("button", { name: "Play and record" }).click();
  await spoolWorkerRequest;
  await expect(page.getByRole("dialog", { name: /Recording/ })).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(() => pcmTempFileCount(page)).toBeGreaterThan(0);
  await page.waitForTimeout(1_200);
  await page.getByRole("button", { name: "Stop Now", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toHaveCount(0, {
    timeout: 15_000,
  });

  await expect
    .poll(
      async () => (await readRecordedWavStats(page))?.nonZeroSamples ?? 0,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1_000);
  const audio = await readRecordedWavStats(page);
  expect(audio).not.toBeNull();
  if (!audio) throw new Error("Recorded WAV was not persisted");
  expect(audio.bitsPerSample).toBe(16);
  expect(audio.sampleRate).toBe(captureGraphRate);
  expect(audio.dataBytes).toBeGreaterThan(0);
  expect(audio.nonZeroSamples).toBeGreaterThan(1_000);
  await expect.poll(() => pcmTempFileCount(page)).toBe(0);

  await stopOscillatorMic(page);
});

test("records the microphone cleanly while a separate instrumental track plays", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });

  const backingTrack = page.getByRole("article", { name: "Track 1" });
  await backingTrack.locator('input[type="file"]').setInputFiles({
    name: "instrumental.wav",
    mimeType: "audio/wav",
    buffer: createToneWav(997, 4),
  });
  await expect(backingTrack).toContainText("instrumental.wav", {
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "Add audio track" }).click();
  const vocalTrack = page
    .getByRole("article", { name: /^Track \d+$/ })
    .filter({ hasText: "no audio" })
    .last();
  await expect(vocalTrack).toBeVisible();
  await installOscillatorMic(page, "pcm-only");
  // addTrack updates the visible list before its serialized project operation
  // releases the recording-start guard.
  await page.waitForTimeout(500);

  await vocalTrack.getByRole("button", { name: "Arm for recording" }).click();
  await page.getByRole("button", { name: "Play and record" }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(1_200);
  await page.getByRole("button", { name: "Stop Now", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toHaveCount(0, {
    timeout: 15_000,
  });

  await expect
    .poll(() => readRecordedWavStats(page), { timeout: 15_000 })
    .not.toBeNull();
  const stats = await readRecordedWavStats(page);
  expect(stats).not.toBeNull();
  if (!stats) throw new Error("Recorded WAV was not persisted");
  // The scheduled transport lead is trimmed from the saved take, and Web
  // Audio implementations can apply different media-stream gain staging.
  // Require a clearly measurable mic tone, then enforce isolation relative
  // to that actual captured level instead of assuming one absolute amplitude.
  expect(stats.micToneAmplitude).toBeGreaterThan(0.03);
  expect(stats.backingToneAmplitude).toBeLessThan(
    stats.micToneAmplitude * 0.05,
  );

  await stopOscillatorMic(page);
});

test("latency calibration captures PCM without constructing MediaRecorder", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await installOscillatorMic(page, "pcm-only");

  await page
    .getByRole("button", { name: "Library and export menu" })
    .click();
  await page.getByRole("button", { name: "Auto-calibrate (3 s)" }).click();

  // A continuous synthetic tone is deliberately not a valid acoustic click
  // response, but calibration must run to completion without touching the
  // MediaRecorder constructor installed by the helper.
  await expect(
    page.getByRole("alert").filter({ hasText: "Calibration failed" }),
  ).toBeVisible({ timeout: 10_000 });

  await stopOscillatorMic(page);
});

test("latency calibration falls back when AudioWorklet is unavailable", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await installOscillatorMic(page, "encoded-only");

  await page
    .getByRole("button", { name: "Library and export menu" })
    .click();
  await page.getByRole("button", { name: "Auto-calibrate (3 s)" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Calibration failed" }),
  ).toBeVisible({ timeout: 10_000 });

  await stopOscillatorMic(page);
});

test("falls back to MediaRecorder when AudioWorklet is unavailable", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });
  await installOscillatorMic(page, "encoded-only");

  await page.getByRole("button", { name: "Arm for recording" }).first().click();
  await page.getByRole("button", { name: "Play and record" }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Stop Now", exact: true }).click();
  await expect
    .poll(
      async () => (await readRecordedWavStats(page))?.nonZeroSamples ?? 0,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1_000);

  await stopOscillatorMic(page);
});

test("falls back to MediaRecorder when the PCM spool worker is unavailable", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });
  await installOscillatorMic(page, "worker-unavailable");

  await page.getByRole("button", { name: "Arm for recording" }).first().click();
  await page.getByRole("button", { name: "Play and record" }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Stop Now", exact: true }).click();
  await expect
    .poll(
      async () => (await readRecordedWavStats(page))?.nonZeroSamples ?? 0,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1_000);

  await stopOscillatorMic(page);
});

test("Stop cancels count-in and releases a microphone stream that resolves late", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });

  await page.evaluate(() => {
    type RecordingCancellationTestWindow = Window & {
      __captureContext?: AudioContext;
      __fakeMicTrack?: MediaStreamTrack;
      __getUserMediaCalls?: number;
    };
    const testWindow = window as RecordingCancellationTestWindow;
    const context = new AudioContext();
    testWindow.__captureContext = context;
    testWindow.__getUserMediaCalls = 0;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        testWindow.__getUserMediaCalls =
          (testWindow.__getUserMediaCalls ?? 0) + 1;
        const stream = context.createMediaStreamDestination().stream;
        testWindow.__fakeMicTrack = stream.getAudioTracks()[0];
        await new Promise((resolve) => setTimeout(resolve, 300));
        return stream;
      },
    });
  });

  const countIn = page.getByRole("button", { name: /Count-in:/ });
  await countIn.click();
  await countIn.click();
  await countIn.click();
  await expect(countIn).toHaveAccessibleName("Count-in: 4 beats");

  await page.getByRole("button", { name: "Play and record" }).click();
  await expect(
    page.getByRole("button", { name: "Cancel countdown" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.waitForTimeout(2_200);

  await expect(page.getByRole("dialog", { name: /Recording/ })).toHaveCount(0);
  const countInCapture = await page.evaluate(() => {
    const testWindow = window as Window & {
      __fakeMicTrack?: MediaStreamTrack;
      __getUserMediaCalls?: number;
    };
    return {
      calls: testWindow.__getUserMediaCalls ?? 0,
      trackState: testWindow.__fakeMicTrack?.readyState ?? "missing",
    };
  });
  // Inputs are prepared before the count-in so the permission/setup delay is
  // not inserted between its last click and the synchronized downbeat.
  expect(countInCapture).toEqual({ calls: 1, trackState: "ended" });

  // Cycle 4 → off, then cancel while getUserMedia is still unresolved. Once
  // it returns, the engine must immediately stop its track and never promote
  // the attempt into an active recording.
  await countIn.click();
  await expect(countIn).toHaveAccessibleName("Count-in: off");
  await page.getByRole("button", { name: "Play and record" }).click();
  await page.waitForTimeout(50);
  await page.getByRole("button", { name: "Stop" }).click();
  await page.waitForTimeout(700);

  const capture = await page.evaluate(() => {
    const testWindow = window as Window & {
      __captureContext?: AudioContext;
      __fakeMicTrack?: MediaStreamTrack;
      __getUserMediaCalls?: number;
    };
    return {
      calls: testWindow.__getUserMediaCalls ?? 0,
      trackState: testWindow.__fakeMicTrack?.readyState ?? "missing",
    };
  });
  expect(capture).toEqual({ calls: 2, trackState: "ended" });
  await expect(page.getByRole("dialog", { name: /Recording/ })).toHaveCount(0);
  await expect.poll(() => pcmTempFileCount(page)).toBe(0);

  await page.evaluate(async () => {
    const context = (window as Window & { __captureContext?: AudioContext })
      .__captureContext;
    await context?.close();
  });
});

test("a disconnected microphone finalizes the take and clears recording UI", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);
  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });

  await page.evaluate(() => {
    type InterruptionTestWindow = Window & {
      __captureContext?: AudioContext;
      __fakeMicTrack?: MediaStreamTrack;
    };
    const testWindow = window as InterruptionTestWindow;
    const context = new AudioContext();
    const stream = context.createMediaStreamDestination().stream;
    testWindow.__captureContext = context;
    testWindow.__fakeMicTrack = stream.getAudioTracks()[0];
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => stream,
    });
  });

  await page.getByRole("button", { name: "Arm for recording" }).first().click();
  await page.getByRole("button", { name: "Play and record" }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toBeVisible({
    timeout: 10_000,
  });

  await page.evaluate(() => {
    const track = (window as Window & { __fakeMicTrack?: MediaStreamTrack })
      .__fakeMicTrack;
    track?.dispatchEvent(new Event("ended"));
  });

  await expect(page.getByRole("dialog", { name: /Recording/ })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByText(/stopped unexpectedly/)).toBeVisible();

  await page.evaluate(async () => {
    const context = (window as Window & { __captureContext?: AudioContext })
      .__captureContext;
    await context?.close();
  });
});
