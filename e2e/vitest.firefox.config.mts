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
          browser: "firefox",
          headless: true,
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
