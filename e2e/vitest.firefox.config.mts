import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [nodePolyfills()],
  test: {
    globals: true,
    testTimeout: 10_000,
    browser: {
      enabled: true,
      name: "firefox",
      provider: "playwright",
      providerOptions: {
        launch: {
          firefoxUserPrefs: {
            'media.navigator.permission.disabled': true,
            'media.navigator.streams.fake': true,
          },
        },
      },
    },
  },
});
