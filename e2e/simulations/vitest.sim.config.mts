/// <reference types="@vitest/browser/providers/playwright" />

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";

const e2eRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Align with ensure-browser.js / run-sim.js when chrome:sim is invoked directly
// (without run-sim). install:browsers writes here by default.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(e2eRoot, ".playwright-browsers");
}
mkdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true });

const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));

/**
 * werift↔Chrome 帯域シミュレーション専用。
 * 通常 e2e (`./tests` / `npm run ci`) には含まれない。
 */
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
    globals: true,
    include: ["./simulations/tests/**/*.sim.test.ts"],
    testTimeout: 45_000,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    browser: {
      provider: "playwright",
      enabled: true,
      instances: [
        {
          browser: "chromium",
          launch: {
            ...(chromiumExecutablePath
              ? { executablePath: chromiumExecutablePath }
              : {}),
            args: [
              "--use-fake-ui-for-media-stream",
              "--use-fake-device-for-media-stream",
              "--ignore-certificate-errors",
              "--allow-insecure-localhost",
              "--disable-features=WebRtcHideLocalIpsWithMdns",
              "--force-webrtc-ip-handling-policy=default_public_interface_only",
            ],
          },
        },
      ],
    },
  },
});
