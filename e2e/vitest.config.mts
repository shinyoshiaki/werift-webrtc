/// <reference types="@vitest/browser/providers/playwright" />

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";

// Without a system Chrome the provider falls back to Playwright's Chromium,
// which ensure-browser.js installs into the package-local browsers path.
// Loaded at runtime: Vite's config bundler cannot inline this CJS helper.
const { applyE2ePlaywrightBrowsersPath } = createRequire(import.meta.url)(
  "./playwright-browsers.js",
);
applyE2ePlaywrightBrowsersPath();

const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  "/usr/bin/google-chrome",
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
    exclude: ["**/node_modules/**", "**/dist/**", "tests/dtls/**"],
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
