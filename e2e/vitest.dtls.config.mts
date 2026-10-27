import { existsSync } from "node:fs";

import { playwright } from "@vitest/browser-playwright";
import { chromium } from "playwright";
import { chromium as chromiumDtls12 } from "playwright-dtls12";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";
import { chromiumLaunchArgs } from "./tests/dtls/chromiumLaunch";

const chromiumMode =
  process.env.DTLS_CHROMIUM_MODE === "dtls13" ? "dtls13" : "dtls12";
const chromiumForMode = chromiumMode === "dtls12" ? chromiumDtls12 : chromium;

let playwrightChromium: string | undefined;
try {
  playwrightChromium = chromiumForMode.executablePath();
} catch {
  playwrightChromium = undefined;
}

// Version assertions are Chromium-revision-specific. Never fall back to
// GHA/system Google Chrome (ubuntu-latest preinstalls a newer Chrome whose
// DTLS 1.3 default ignores WebRTC-ForceDtls13/Disabled). The DTLS 1.2 mode
// uses the pinned Chromium 140 package because Chromium 156 no longer honors
// that field trial.
const override = process.env.DTLS_CHROME_BIN;
const chromiumExecutablePath =
  override && existsSync(override) ? override : playwrightChromium;

if (!chromiumExecutablePath || !existsSync(chromiumExecutablePath)) {
  throw new Error(
    "DTLS e2e requires Playwright Chromium. From e2e/ run `npm run install:browsers`.",
  );
}

console.info(
  `[dtls e2e] mode=${chromiumMode} executable=${chromiumExecutablePath}`,
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
      provider: playwright({
        launchOptions: {
          executablePath: chromiumExecutablePath,
          args: chromiumLaunchArgs(chromiumMode),
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
