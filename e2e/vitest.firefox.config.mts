import { playwright } from "@vitest/browser-playwright";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { defineConfig } from "vitest/config";

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
    // fileParallelism: false,
    retry: 1,
    exclude: ["**/node_modules/**", "**/dist/**", "tests/dtls/**"],
    browser: {
      provider: playwright({
        launchOptions: {
          firefoxUserPrefs: {
            "media.navigator.permission.disabled": true,
            "media.navigator.streams.fake": true,
          },
        },
      }),
      enabled: true,
      instances: [
        {
          browser: "firefox",
        },
      ],
    },
  },
});
