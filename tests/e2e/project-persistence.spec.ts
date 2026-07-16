import { expect, test } from "@playwright/test";
import { join } from "node:path";

async function waitForShell(page: import("@playwright/test").Page) {
  const shell = page.getByRole("button", { name: /Start Demo|Exit Demo/ });
  const resume = page.getByRole("button", { name: "Resume Session" });
  await expect(shell.or(resume)).toBeVisible({ timeout: 10_000 });
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await expect(shell).toBeVisible();
}

test("sampler patterns and copied samples survive reload and source deletion", async ({
  page,
}) => {
  await page.goto("/");
  await waitForShell(page);

  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });

  // History snapshots must not rewind live recording controls that are not
  // themselves Undo actions.
  const audioTrack = page.getByRole("article", { name: "Track 1" });
  const armButton = audioTrack.getByRole("button", {
    name: "Arm for recording",
  });
  const muteButton = audioTrack.getByRole("button", { name: "Mute" });
  await armButton.click();
  await muteButton.click();
  await armButton.click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(muteButton).toHaveAttribute("aria-pressed", "false");
  await expect(armButton).toHaveAttribute("aria-pressed", "false");

  await page
    .getByRole("button", { name: /Enable pattern recording/ })
    .click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const firstPad = page.getByRole("button", { name: /Trigger pad 1:/ }).first();
  await firstPad.click();
  await firstPad.click();
  await firstPad.click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("3 events", { exact: false })).toBeVisible();

  // Rapid queued hits form one undoable recording action. Undo/redo runs on
  // the same serialization boundary, so it cannot race a pending commit.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("3 events", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(page.getByText("3 events", { exact: false })).toBeVisible();

  // Consuming the current sampler-record history group while transport is
  // still rolling must let the next hit open a fresh undo group.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await firstPad.click();
  await expect(page.getByText("4 events", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("3 events", { exact: false })).toBeVisible();
  await firstPad.click();
  await expect(page.getByText("4 events", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("3 events", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();

  // A sampler overdub is one project-wide history action. Per-track grouping
  // is invalid because each history entry contains every track: A→B→A must
  // undo all three new hits, not leave A's first hit behind.
  await page.getByRole("button", { name: "Add sampler track" }).click();
  const secondSampler = page.getByRole("article", { name: "Sampler 3" });
  await expect(secondSampler).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(secondSampler).toHaveCount(0);
  await expect(
    page
      .getByRole("article", { name: "Drum Kit" })
      .getByText("3 events", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(secondSampler).toBeVisible();
  await secondSampler
    .locator('input[type="file"]')
    .first()
    .setInputFiles(join(process.cwd(), "public/demo/neptunes-80.wav"));
  const secondPad = secondSampler.getByRole("button", {
    name: /Trigger pad 1:/,
  });
  await expect(secondPad).toBeEnabled();
  await secondSampler
    .getByRole("button", { name: /Enable pattern recording/ })
    .click();

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await firstPad.click();
  await secondPad.click();
  await firstPad.click();
  await expect(
    page
      .getByRole("article", { name: "Drum Kit" })
      .getByText("5 events", { exact: false }),
  ).toBeVisible();
  await expect(secondSampler.getByText("1 event", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page
      .getByRole("article", { name: "Drum Kit" })
      .getByText("3 events", { exact: false }),
  ).toBeVisible();
  await expect(secondSampler.getByText(/events?/)).toHaveCount(0);
  await page.getByRole("button", { name: "Stop" }).click();

  // A normal debounced edit must also survive a reload issued immediately
  // after its synchronous UI commit. The unload recovery journal covers the
  // window in which browsers may terminate an asynchronous IndexedDB flush.
  const tempo = page.getByRole("spinbutton", {
    name: "Tempo in beats per minute",
  });
  await tempo.fill("137");
  await tempo.press("Enter");
  await expect(tempo).toHaveValue("137");
  await page.getByRole("button", { name: "Time signature: 4/4" }).click();
  await expect(
    page.getByRole("button", { name: "Time signature: 5/4" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByRole("button", { name: "Time signature: 4/4" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(
    page.getByRole("button", { name: "Time signature: 5/4" }),
  ).toBeVisible();
  await expect(page.getByText("3 events", { exact: false })).toBeVisible();

  await page.reload();
  await waitForShell(page);
  await expect(page.getByText("3 events", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Tempo in beats per minute" }),
  ).toHaveValue("137");
  await expect(
    page.getByRole("button", { name: "Time signature: 5/4" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept("Copy"));
  await page.getByRole("button", { name: "Save as new project…" }).click();
  await expect(page.getByText("Copy", { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "Library and export menu" }).click();
  const library = page.getByRole("dialog", {
    name: "Project, audio, and export settings",
  });
  await library
    .getByRole("button")
    .filter({ hasText: /^Demo/ })
    .click();
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "Library and export menu" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete this project" }).click();
  await expect(page.getByText("Copy", { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });

  await page.reload();
  await waitForShell(page);
  await expect(page.getByText("3 events", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Trigger pad 1:/ }).first(),
  ).toBeEnabled();
});
