import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    minWorkers: 3,
    maxWorkers: 3,
    retry: 1,
  },
});
