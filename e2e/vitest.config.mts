import { createRequire } from "node:module";

import { playwright } from "@vitest/browser-playwright";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";

// Without a system Chrome the provider falls back to Playwright's Chromium,
// which ensure-browser.js installs into the package-local browsers path.
// Loaded at runtime: Vite's config bundler cannot inline this CJS helper.
const { applyE2ePlaywrightBrowsersPath } = createRequire(import.meta.url)(
  "./playwright-browsers.js",
);
applyE2ePlaywrightBrowsersPath();

// Loaded via require so Vite does not bundle the CommonJS helper.
const { resolveChromeExecutable } = createRequire(import.meta.url)(
  "./browser-paths.js",
) as { resolveChromeExecutable: () => string | undefined };

/** Prefer Google Chrome for proprietary H.264 (P0 codec E2E). */
const chromiumExecutablePath = resolveChromeExecutable();

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
    // Node-only tests live in tools/tests (npm run test:tools)
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Browser テストは 1 台のブラウザと e2e サーバ資源を共有するため、
    // ファイル並列で実行すると負荷でタイミング依存のテストが不安定になる。
    // ice-server の chrome-e2e ハーネスと同じく直列実行に固定する。
    fileParallelism: false,
    retry: 1,
    exclude: ["**/node_modules/**", "**/dist/**", "tests/dtls/**"],
    browser: {
      provider: playwright({
        launchOptions: {
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
            "--no-sandbox",
            "--disable-dev-shm-usage",
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
