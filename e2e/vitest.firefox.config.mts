/// <reference types="@vitest/browser/providers/playwright" />
import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

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
          browser: "firefox",
          launch: {
            firefoxUserPrefs: {
              "media.navigator.permission.disabled": true,
              "media.navigator.streams.fake": true,
            },
          },
        },
      ],
    },
  },
});
