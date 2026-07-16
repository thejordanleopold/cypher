import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node scripts/serve-static.mjs out 4173",
    url: "http://127.0.0.1:4173",
    // Own the server by default. Back-to-back Playwright commands can briefly
    // overlap teardown; auto-attaching to the previous command's child makes
    // the next suite lose its server halfway through. Developers can opt into
    // reuse explicitly when they intentionally run a persistent server.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 30_000,
  },
});
