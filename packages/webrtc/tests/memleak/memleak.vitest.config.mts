import { defineConfig } from "vitest/config";

/**
 * メモリリーク試験専用 vitest 設定。
 * - 並列無効（ヒープ計測が他テストと混ざらないようにする）
 * - retry 無効（リーク失敗を隠さない）
 * - --expose-gc を worker に伝搬
 * - 長時間実行向け timeout
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/memleak/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        execArgv: ["--expose-gc"],
      },
    },
  },
});
