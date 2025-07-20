/// <reference types="@vitest/browser/providers/playwright" />

import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [nodePolyfills()],
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
          headless: true,
          launch: {
            args: [
              "--use-fake-ui-for-media-stream",
              "--use-fake-device-for-media-stream",
            ],
          },
        },
      ],
    },
  },
});
