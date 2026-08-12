const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");

/**
 * Prefer a worktree-local browser cache so concurrent CI jobs sharing
 * ~/.cache/ms-playwright cannot race / prune each other's installs.
 * Matches e2e/.gitignore `.playwright-browsers/`.
 *
 * Exported for run-sim.js / run-ci.js / run-chrome-prod.js so every Playwright
 * entrypoint uses the same path without requiring the user to export it.
 */
function ensureBrowsersPathEnv(env = process.env) {
  if (!env.PLAYWRIGHT_BROWSERS_PATH) {
    env.PLAYWRIGHT_BROWSERS_PATH = join(__dirname, ".playwright-browsers");
  }
  mkdirSync(env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true });
  return env.PLAYWRIGHT_BROWSERS_PATH;
}

function resolveSystemChrome() {
  return [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
}

/** Candidate headless-shell paths across Playwright layout generations. */
function headlessShellCandidates(browsersRoot, revision) {
  const base = join(browsersRoot, `chromium_headless_shell-${revision}`);
  return [
    join(base, "chrome-linux", "headless_shell"),
    join(base, "chrome-linux64", "headless_shell"),
    join(base, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    join(base, "chrome-headless-shell-linux", "chrome-headless-shell"),
  ];
}

function resolveHeadlessShellPath(browsersRoot, revision) {
  return headlessShellCandidates(browsersRoot, revision).find((p) =>
    existsSync(p),
  );
}

/**
 * True when Playwright chromium + matching headless shell are both present.
 * Headless shell is required for vitest --browser.headless with Playwright
 * when no system Chrome executablePath is configured.
 */
function hasPlaywrightChromium() {
  try {
    // Require after PLAYWRIGHT_BROWSERS_PATH is set so paths resolve correctly.
    const { chromium } = require("playwright");
    const chromiumExecutablePath = chromium.executablePath();
    if (!existsSync(chromiumExecutablePath)) {
      return false;
    }

    const chromiumDir = dirname(dirname(chromiumExecutablePath));
    const revision = basename(chromiumDir).replace(/^chromium-/, "");
    if (!revision) return false;

    const browsersRoot = dirname(chromiumDir);
    return Boolean(resolveHeadlessShellPath(browsersRoot, revision));
  } catch {
    return false;
  }
}

function installPlaywrightBrowsers() {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  // Use local package binary via npx so revision matches e2e/playwright.
  const result = spawnSync(
    command,
    ["playwright", "install", "chromium", "chromium-headless-shell"],
    {
      stdio: "inherit",
      env: process.env,
      cwd: __dirname,
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function main() {
  ensureBrowsersPathEnv(process.env);

  // vitest.config.mts pins launch.executablePath when a system Chrome exists,
  // so Playwright headless-shell is optional in that environment.
  if (resolveSystemChrome() || hasPlaywrightChromium()) {
    process.exit(0);
  }

  let status = installPlaywrightBrowsers();
  if (status !== 0) {
    process.exit(status);
  }

  // Verify immediately — incomplete unzip / cache races must not pass silently.
  if (hasPlaywrightChromium()) {
    process.exit(0);
  }

  console.error(
    "[ensure-browser] Playwright chromium/headless-shell missing after install; retrying once…",
  );
  console.error(
    `[ensure-browser] PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`,
  );
  status = installPlaywrightBrowsers();
  if (status !== 0) {
    process.exit(status);
  }

  if (!hasPlaywrightChromium()) {
    console.error(
      "[ensure-browser] Failed to install a usable Playwright chromium + headless shell.",
    );
    console.error(
      `[ensure-browser] PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`,
    );
    try {
      const { chromium } = require("playwright");
      const path = chromium.executablePath();
      console.error(
        `[ensure-browser] chromium.executablePath()=${path} exists=${existsSync(path)}`,
      );
    } catch (error) {
      console.error(
        "[ensure-browser] could not resolve chromium.executablePath()",
        error,
      );
    }
    process.exit(1);
  }

  process.exit(0);
}

module.exports = {
  ensureBrowsersPathEnv,
  hasPlaywrightChromium,
  resolveSystemChrome,
};

if (require.main === module) {
  main();
}
