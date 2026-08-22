/// <reference types="@vitest/browser/providers/playwright" />

import { existsSync } from "node:fs";

import { chromium } from "playwright";
import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

let playwrightChromium: string | undefined;
try {
  playwrightChromium = chromium.executablePath();
} catch {
  playwrightChromium = undefined;
}

const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  playwrightChromium,
].find((candidate) => candidate && existsSync(candidate));

const chromiumMode =
  process.env.DTLS_CHROMIUM_MODE === "dtls13" ? "dtls13" : "dtls12";
const forceDtls13 = chromiumMode === "dtls13" ? "Only" : "Off";

export default defineConfig({
  plugins: [nodePolyfills()],
  define: {
    "import.meta.env.VITE_DTLS_CHROMIUM_MODE": JSON.stringify(chromiumMode),
  },
  optimizeDeps: {
    include: [
      "vite-plugin-node-polyfills/shims/buffer",
      "vite-plugin-node-polyfills/shims/global",
      "vite-plugin-node-polyfills/shims/process",
    ],
  },
  test: {
    name: `dtls-${chromiumMode}`,
    globals: true,
    include: ["tests/dtls/**/*.test.ts"],
    testTimeout: 40_000,
    fileParallelism: false,
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
              `--force-fieldtrials=WebRTC-ForceDtls13/${forceDtls13}/WebRTC-IceHandshakeDtls/Disabled/`,
            ],
          },
        },
      ],
    },
  },
});
