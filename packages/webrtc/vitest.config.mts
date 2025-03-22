import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    minWorkers: 2,
    maxWorkers: 2,
    retry: 1,
  },
});
