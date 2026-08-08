import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    minWorkers: 3,
    maxWorkers: 3,
    retry: 1,
    // メモリリーク試験は専用 config / npm run memleak でのみ実行する
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/memleak/**",
    ],
  },
});
