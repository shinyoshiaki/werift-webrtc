import { existsSync } from "node:fs";

import { playwright } from "@vitest/browser-playwright";
import { chromium } from "playwright";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";
import { chromiumSpedLaunchArgs } from "./tests/dtls/chromiumLaunch";

let playwrightChromium: string | undefined;
try {
  playwrightChromium = chromium.executablePath();
} catch {
  playwrightChromium = undefined;
}

// Use Playwright's Chromium, not GHA/system Google Chrome, so the DTLS
// assertions run against a known Chromium revision. DTLS 1.2 is selected by
// limiting werift's advertised versions, not by capping Chromium.
const override = process.env.DTLS_CHROME_BIN;
const chromiumExecutablePath =
  override && existsSync(override) ? override : playwrightChromium;

if (!chromiumExecutablePath || !existsSync(chromiumExecutablePath)) {
  throw new Error(
    "DTLS e2e requires Playwright Chromium. From e2e/ run `npm run install:browsers`.",
  );
}

console.info(`[sped e2e] executable=${chromiumExecutablePath}`);

export default defineConfig({
  plugins: [nodePolyfills()],
  optimizeDeps: {
    include: [
      "vite-plugin-node-polyfills/shims/buffer",
      "vite-plugin-node-polyfills/shims/global",
      "vite-plugin-node-polyfills/shims/process",
    ],
  },
  test: {
    name: "sped",
    globals: true,
    include: ["tests/sped/**/*.test.ts"],
    testTimeout: 40_000,
    fileParallelism: false,
    retry: 1,
    browser: {
      provider: playwright({
        launchOptions: {
          executablePath: chromiumExecutablePath,
          args: chromiumSpedLaunchArgs,
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
