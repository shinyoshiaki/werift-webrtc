import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    retry: 1,
    testTimeout: 5000,
  },
});
