// Settings shared by the Chrome (vitest.config.mts) and Firefox
// (vitest.firefox.config.mts) E2E configs. Each config adds its own browser
// provider and instance.
import { nodePolyfills } from "vite-plugin-node-polyfills";
import type { ViteUserConfig } from "vitest/config";

export const sharedPlugins = (): ViteUserConfig["plugins"] => [nodePolyfills()];

export const sharedOptimizeDeps: ViteUserConfig["optimizeDeps"] = {
  include: [
    "vite-plugin-node-polyfills/shims/buffer",
    "vite-plugin-node-polyfills/shims/global",
    "vite-plugin-node-polyfills/shims/process",
  ],
};

export const sharedTest = {
  globals: true,
  testTimeout: 20_000,
  // Node-only tests live in tools/tests (npm run test:tools).
  // CI / chrome:prod は通常 e2e のみ。simulations は CI 対象外（npm run test:sim）。
  // CLI の `./tests` フィルタは部分一致で simulations/tests にも当たるため、
  // include を通常 e2e に限定し simulations を明示 exclude する。
  include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
  // tests/dtls has its own config (vitest.dtls.config.mts, npm run dtls), and
  // tests/sped the opt-in Chromium SPED one (vitest.sped.config.mts).
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/simulations/**",
    "lib/**",
    "tests/dtls/**",
    "tests/sped/**",
  ],
  // Browser テストは 1 台のブラウザと e2e サーバ資源を共有するため、
  // ファイル並列で実行すると負荷でタイミング依存のテストが不安定になる。
  // ice-server の chrome-e2e ハーネスと同じく直列実行に固定する。
  fileParallelism: false,
  retry: 1,
} satisfies NonNullable<ViteUserConfig["test"]>;
