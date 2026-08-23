/// <reference types="@vitest/browser/providers/playwright" />

import { existsSync } from "node:fs";

import { chromium } from "playwright";
import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { chromiumLaunchArgs } from "./tests/dtls/chromiumLaunch";

let playwrightChromium: string | undefined;
try {
  playwrightChromium = chromium.executablePath();
} catch {
  playwrightChromium = undefined;
}

const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  playwrightChromium,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));

const chromiumMode =
  process.env.DTLS_CHROMIUM_MODE === "dtls13" ? "dtls13" : "dtls12";

console.info(
  `[dtls e2e] mode=${chromiumMode} executable=${chromiumExecutablePath ?? "playwright-default"}`,
);

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
            args: chromiumLaunchArgs(chromiumMode),
          },
        },
      ],
    },
  },
});
