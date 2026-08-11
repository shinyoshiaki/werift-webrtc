/// <reference types="@vitest/browser/providers/playwright" />

import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

/** Prefer Google Chrome for proprietary H.264 (P0 codec E2E). */
const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  join(__dirname, ".cache/google-chrome/opt/google/chrome/google-chrome"),
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));

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
    testTimeout: 20_000,
    // fileParallelism: false,
    retry: 1,
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
              // Extracted Chrome often needs these in CI/containers
              "--no-sandbox",
              "--disable-dev-shm-usage",
            ],
          },
        },
      ],
    },
  },
});
