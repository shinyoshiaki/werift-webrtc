import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // browser-e2e は Chromium 専用（npm run test:browser）なので Node の実行から外す
    exclude: [...configDefaults.exclude, "browser-e2e/**"],
  },
});
