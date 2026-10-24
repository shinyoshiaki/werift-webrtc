import { nodePolyfills } from "vite-plugin-node-polyfills";
import { playwright } from "@vitest/browser-playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    nodePolyfills({
      exclude: ["dgram", "net", "tls", "fs", "child_process"],
    }),
  ],
  resolve: {
    alias: {
      buffer: "buffer/",
      dgram: path.resolve(fileURLToPath(new URL(".", import.meta.url)), "stubs/dgram.ts"),
      "node:dgram": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "stubs/dgram.ts"),
      net: path.resolve(fileURLToPath(new URL(".", import.meta.url)), "stubs/net.ts"),
      "node:net": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "stubs/net.ts"),
    },
  },
  optimizeDeps: {
    include: ["buffer", "vite-plugin-node-polyfills/shims/buffer"],
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    browser: {
      provider: playwright(),
      enabled: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
