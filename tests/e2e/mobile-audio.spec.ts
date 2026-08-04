import { expect, test } from "@playwright/test";

async function installSyntheticMic(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    type MobileAudioTestWindow = Window & {
      __mobileCaptureContext?: AudioContext;
      __mobileCaptureOscillator?: OscillatorNode;
    };
    const testWindow = window as MobileAudioTestWindow;
    // Use the platform's native graph rate. Mobile Bluetooth routes can be
    // 16–24 kHz; forcing a desktop rate would test a conversion the app must
    // deliberately avoid rather than the device path it actually receives.
    const context = new AudioContext();
    await context.resume();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.2;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    testWindow.__mobileCaptureContext = context;
    testWindow.__mobileCaptureOscillator = oscillator;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => destination.stream,
    });
    return context.sampleRate;
  });
}

async function readRecordingHeader(
  page: import("@playwright/test").Page,
): Promise<{ dataBytes: number; sampleRate: number } | null> {
  return page.evaluate(
    () =>
      new Promise<{ dataBytes: number; sampleRate: number } | null>(
        (resolve, reject) => {
          const open = indexedDB.open("cypher", 2);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const meta = db
              .transaction("meta", "readonly")
              .objectStore("meta")
              .get("currentProjectId");
            meta.onerror = () => reject(meta.error);
            meta.onsuccess = () => {
              const project = db
                .transaction("projects", "readonly")
                .objectStore("projects")
                .get(meta.result);
              project.onerror = () => reject(project.error);
              project.onsuccess = () => {
                const track = (
                  project.result as {
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
                const audio = db
                  .transaction("audio", "readonly")
                  .objectStore("audio")
                  .get(track.audioKey);
                audio.onerror = () => reject(audio.error);
                audio.onsuccess = () => {
                  const stored = audio.result;
                  db.close();
                  if (!(stored instanceof ArrayBuffer) || stored.byteLength < 44) {
                    resolve(null);
                    return;
                  }
                  const view = new DataView(stored);
                  resolve({
                    dataBytes: view.getUint32(40, true),
                    sampleRate: view.getUint32(24, true),
                  });
                };
              };
            };
          };
        },
      ),
  );
}

async function ensureFirstAudioTrackArmed(
  page: import("@playwright/test").Page,
) {
  const arm = page.getByRole("button", { name: "Arm for recording" }).first();
  if ((await arm.getAttribute("aria-pressed")) !== "true") await arm.click();
}

test("mobile PWA shell records and persists native-rate audio", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start Demo" })).toBeVisible({
    timeout: 15_000,
  });

  const platform = await page.evaluate(async () => {
    const manifest = await fetch("./manifest.webmanifest");
    const worklet = await fetch("./worklets/pcm-recorder.js");
    const worker = await fetch("./workers/pcm-spooler.js");
    const smallestButton = Math.min(
      ...Array.from(document.querySelectorAll("button"), (button) =>
        button.getBoundingClientRect().width,
      ),
    );
    return {
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
      manifest: manifest.ok,
      manifestType: manifest.headers.get("content-type") ?? "",
      smallestButton,
      worker: worker.ok,
      worklet: worklet.ok,
    };
  });
  expect(platform.bodyOverflow).toBeLessThanOrEqual(1);
  expect(platform.smallestButton).toBeGreaterThanOrEqual(36);
  expect(platform.manifest).toBe(true);
  expect(platform.manifestType).toContain("application/manifest+json");
  expect(platform.worker).toBe(true);
  expect(platform.worklet).toBe(true);

  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });
  const nativeRate = await installSyntheticMic(page);

  await ensureFirstAudioTrackArmed(page);
  await page.getByRole("button", { name: "Play and record" }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Stop Now", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toHaveCount(0, {
    timeout: 20_000,
  });

  await expect
    .poll(() => readRecordingHeader(page), { timeout: 15_000 })
    .not.toBeNull();
  const recording = await readRecordingHeader(page);
  expect(recording?.sampleRate).toBe(nativeRate);
  expect(recording?.dataBytes ?? 0).toBeGreaterThan(1_000);

  // iOS and Android can background an installed web app without a reliable
  // beforeunload. pagehide must finalize the take instead of abandoning the
  // microphone stream or leaving the recording shield stuck on return.
  await ensureFirstAudioTrackArmed(page);
  await page.getByRole("button", { name: "Play and record" }).click();
  await expect(page.getByRole("dialog", { name: /Recording/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.getByRole("dialog", { name: /Recording/ })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect
    .poll(async () => (await readRecordingHeader(page))?.dataBytes ?? 0, {
      timeout: 15_000,
    })
    .toBeGreaterThan(1_000);

  await page.evaluate(async () => {
    const testWindow = window as Window & {
      __mobileCaptureContext?: AudioContext;
      __mobileCaptureOscillator?: OscillatorNode;
    };
    testWindow.__mobileCaptureOscillator?.stop();
    await testWindow.__mobileCaptureContext?.close();
  });
});
