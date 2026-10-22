/// <reference types="@vitest/browser/providers/playwright" />

import { createRequire } from "node:module";

import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";

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
    // CI / chrome:prod は通常 e2e のみ。simulations は CI 対象外（npm run test:sim）。
    // CLI の `./tests` フィルタは部分一致で simulations/tests にも当たるため、
    // include を通常 e2e に限定し simulations を明示 exclude する。
    include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/simulations/**",
      "lib/**",
    ],
    // Browser テストは 1 台のブラウザと e2e サーバ資源を共有するため、
    // ファイル並列で実行すると負荷でタイミング依存のテストが不安定になる。
    // ice-server の chrome-e2e ハーネスと同じく直列実行に固定する。
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
