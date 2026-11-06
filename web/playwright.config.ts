import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { browserName: "chromium", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: `bun run ../scripts/paper-demo.ts --serve --port 3100 --data-dir /tmp/jev-browser-${process.pid}`,
      url: "http://127.0.0.1:3100/", reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command: "bun run start", url: "http://127.0.0.1:3001/", reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
  ],
});
