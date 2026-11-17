import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    maxWorkers: 3,
    retry: 1,
    // 組み込みの公開 STUN サーバーへ届かない環境でも結果が変わらないようにする
    setupFiles: ["./tests/setup/hermeticDefaultStun.ts"],
    // メモリリーク試験は専用 config / npm run memleak でのみ実行する
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/memleak/**",
    ],
  },
});
