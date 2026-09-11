const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

function playwrightInstallEnv() {
  const env = { ...process.env };
  if (env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
    return env;
  }
  try {
    const osRelease = readFileSync("/etc/os-release", "utf8");
    const id = osRelease.match(/^ID="?([^"\n]+)"?/m)?.[1];
    const version = osRelease.match(/^VERSION_ID="?([^"\n]+)"?/m)?.[1];
    const major = Number(version?.split(".")[0]);
    // Playwright 1.55 has no ubuntu26.04 browser builds. Reuse 24.04 artifacts.
    if (id === "ubuntu" && Number.isFinite(major) && major >= 26) {
      env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu24.04-x64";
    }
  } catch {
    // non-linux or unreadable os-release: keep Playwright's default detection
  }
  return env;
}

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
  { cwd: __dirname, env: playwrightInstallEnv(), stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}
