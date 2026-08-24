const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

// DTLS version tests must use Playwright's pinned Chromium. The shared
// installer skips download when /usr/bin/google-chrome exists (GHA), so
// install this package's Playwright browsers directly.
const playwrightPackageJson = require.resolve("playwright/package.json", {
  paths: [__dirname],
});
const cliPath = join(dirname(playwrightPackageJson), "cli.js");
const result = spawnSync(
  process.execPath,
  [cliPath, "install", "chromium", "chromium-headless-shell"],
  { cwd: __dirname, stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}
