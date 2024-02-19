import { defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [nodePolyfills()],
  test: {
    globals: true,
    testTimeout: 20_000,
    // maxConcurrency: 1,
    browser: {
      enabled: true,
      name: "chromium",
      provider: "playwright",
      providerOptions: {
        launch: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
          ],
        },
      },
    },
  },
});
