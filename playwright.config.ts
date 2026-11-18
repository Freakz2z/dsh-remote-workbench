import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4720",
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "RW_FIXTURE=1 npm run dev",
    url: "http://127.0.0.1:4720",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
