// Browser tests (e2e/) against the built site, in Chromium, Firefox and WebKit (Safari's engine).
// The shop's API is mocked per test, so runs are repeatable and need no AWS or Square access.
//   npm run build && npm run test:e2e
import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// Locally: Chrome on macOS, Edge on Windows; CI installs Playwright's Chromium.
const localChannel = existsSync("/Applications/Google Chrome.app") ? "chrome" : "msedge";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.mjs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // In CI, "github" puts each failure on the pull request as an annotation (visible without signing in).
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
  webServer: {
    command: "node scripts/serve.mjs 4173 --pieces e2e/fixtures/pieces.json",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: process.env.CI ? undefined : localChannel } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
