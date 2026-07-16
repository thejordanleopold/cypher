import { expect, test } from "@playwright/test";

test("the installed static app reloads from its revisioned cache offline", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start Demo" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForFunction(
    () => "serviceWorker" in navigator && navigator.serviceWorker.controller,
    undefined,
    { timeout: 30_000 },
  );

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Start Demo" })).toBeVisible({
    timeout: 10_000,
  });
});
