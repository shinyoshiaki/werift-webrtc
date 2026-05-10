import { defineConfig } from "vitest/config";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const packageDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/wpt-runner/vitest.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
  coverage: {
    provider: "v8",
    reportsDirectory: resolve(packageDir, "coverage"),
    include: ["src/**/*.ts"],
  },
});
