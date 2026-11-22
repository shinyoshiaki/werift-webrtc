import { defineConfig } from "vitest/config";

/**
 * The fixture files `runDeepSearch` runs in `tests/deep.test.ts`
 * (`*.fixture.ts`, so the package's own `vitest run ./tests` skips them).
 */
export default defineConfig({
  test: {
    include: ["*.fixture.ts"],
  },
});
