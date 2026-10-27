import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { playwright } from "@vitest/browser-playwright";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";
import { chromiumLaunchArgs } from "./tests/dtls/chromiumLaunch";

// ensure-browser.js installs the pinned Chromium into the package-local
// browsers path; point Playwright there before loading it.
// Loaded at runtime: Vite's config bundler cannot inline this CJS helper.
const { applyE2ePlaywrightBrowsersPath } = createRequire(import.meta.url)(
  "./playwright-browsers.js",
);
applyE2ePlaywrightBrowsersPath();
// hoist-imports-allow: Playwright reads PLAYWRIGHT_BROWSERS_PATH at module load
const { chromium } = await import("playwright");
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

console.info(`[dtls e2e] executable=${chromiumExecutablePath}`);

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
    name: "dtls",
    globals: true,
    include: ["tests/dtls/**/*.test.ts"],
    testTimeout: 40_000,
    fileParallelism: false,
    retry: 1,
    browser: {
      provider: playwright({
        launchOptions: {
          executablePath: chromiumExecutablePath,
          args: chromiumLaunchArgs,
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
