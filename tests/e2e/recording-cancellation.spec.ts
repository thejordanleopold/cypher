import { expect, test } from "@playwright/test";

async function waitForShell(page: import("@playwright/test").Page) {
  const shell = page.getByRole("button", { name: /Start Demo|Exit Demo/ });
  const resume = page.getByRole("button", { name: "Resume Session" });
  await expect(shell.or(resume)).toBeVisible({ timeout: 10_000 });
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await expect(shell).toBeVisible();
}

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
