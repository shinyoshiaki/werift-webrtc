import { existsSync } from "node:fs";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
    retry: 1,
    browser: {
      provider: playwright({
        launchOptions: {
          ...(chromiumExecutablePath
            ? { executablePath: chromiumExecutablePath }
            : {}),
          args: [
            "--ignore-certificate-errors",
            "--allow-insecure-localhost",
          ],
        },
      }),
      enabled: true,
      instances: [
        {
          browser: "chromium",
        },
      ],
    },
  },
});
