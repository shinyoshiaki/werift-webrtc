import { defineWorkspace } from "vitest/config";

export default defineWorkspace(["./packages/*/vitest.config.mts", "e2e/vitest.config.mts"]);
