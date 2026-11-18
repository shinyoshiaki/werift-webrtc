import { createRequire } from "node:module";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import {
  sharedOptimizeDeps,
  sharedPlugins,
  sharedTest,
} from "./vitest.shared.mts";

// Loaded via require so Vite does not bundle the CommonJS helper.
const { resolveChromeExecutable } = createRequire(import.meta.url)(
  "./browser-paths.js",
) as { resolveChromeExecutable: () => string | undefined };

/** Prefer Google Chrome for proprietary H.264 (P0 codec E2E). */
const chromiumExecutablePath = resolveChromeExecutable();

export default defineConfig({
  plugins: sharedPlugins(),
  optimizeDeps: sharedOptimizeDeps,
  test: {
    ...sharedTest,
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
