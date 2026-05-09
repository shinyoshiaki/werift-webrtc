/// <reference types="@vitest/browser/providers/playwright" />

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
    retry: 1,
    browser: {
      provider: "playwright",
      enabled: true,
      instances: [
        {
          browser: "chromium",
        },
      ],
    },
  },
});
