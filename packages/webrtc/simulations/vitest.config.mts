import { defineConfig } from "vitest/config";

/**
 * GCC/TWCC シミュレーション専用。
 * `npm test` / CI (`vitest run ./tests`) には含まれない。
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["**/*.sim.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // シミュレーションは時間依存のため並列を抑える
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
  },
});
