import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Only source tests. Production build must not put compiled tests under lib/
    // (see tsconfig.production.json), and vitest must not re-run them.
    include: ["tests/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/lib/**"],
  },
});
