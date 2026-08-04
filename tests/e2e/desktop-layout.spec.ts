import { expect, test } from "@playwright/test";

test("desktop workspace stays bounded and exposes desktop-native controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start Demo" })).toBeVisible({
    timeout: 15_000,
  });

  const workspaceView = page.getByRole("group", { name: "Workspace view" });
  await expect(workspaceView).toBeVisible();
  await expect(
    workspaceView.getByRole("button", { name: "Tracks" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Switch to mixer view" }),
  ).toBeHidden();

  await page.getByRole("button", { name: "Start Demo" }).click();
  await expect(page.getByRole("button", { name: "Exit Demo" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("heading", { name: "Arrangement" }),
  ).toBeVisible();

  const sampler = page.getByRole("article", { name: "Drum Kit" });
  const samplerBox = await sampler.boundingBox();
  expect(samplerBox).not.toBeNull();
  expect(samplerBox?.width ?? Infinity).toBeLessThanOrEqual(1280);

  const firstPad = page.getByRole("button", { name: /^Trigger pad 1:/ });
  const eighthPad = page.getByRole("button", {
    name: "Pad 8 — tap to load a sample",
  });
  const [firstPadBox, eighthPadBox] = await Promise.all([
    firstPad.boundingBox(),
    eighthPad.boundingBox(),
  ]);
  expect(firstPadBox).not.toBeNull();
  expect(eighthPadBox).not.toBeNull();
  expect(Math.abs((firstPadBox?.y ?? 0) - (eighthPadBox?.y ?? 0))).toBeLessThan(2);
  expect(firstPadBox?.width ?? Infinity).toBeLessThan(180);

  await workspaceView.getByRole("button", { name: "Mixer" }).click();
  const channelStrip = page.locator(".mixer-channel-strip").first();
  await expect(channelStrip).toBeVisible();
  const channelBox = await channelStrip.boundingBox();
  const addStripBox = await page.locator(".mixer-add-strip").boundingBox();
  expect(channelBox?.height ?? 0).toBeGreaterThanOrEqual(420);
  expect(addStripBox?.height).toBe(channelBox?.height);
  expect(channelBox?.x ?? Infinity).toBeLessThan(240);
});
