const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { ensurePlaywrightBrowsersPath } = require("./browsers-path");
ensurePlaywrightBrowsersPath();
const {
  playwrightInstallEnv,
} = require("../scripts/playwright-host-platform.js");
const { withE2ePlaywrightBrowsersPath } = require("./playwright-browsers.js");

function resolveSystemChrome() {
  return [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
}

const {
  canAutoDownloadGoogleChrome,
  resolveCachedGoogleChrome,
} = require("./browser-paths");

/**
 * Prefer Google Chrome (proprietary H.264) for P0 H.264 codec E2E.
 * Downloads a user-local extract when system Chrome is missing (no root).
 */
function ensureGoogleChromeForH264() {
  const systemChrome =
    resolveSystemChrome() ||
    (existsSync("/usr/bin/google-chrome-stable")
      ? "/usr/bin/google-chrome-stable"
      : undefined);
  const existing = systemChrome || resolveCachedGoogleChrome();
  if (
    existing &&
    (existing.includes("google-chrome") || process.env.CHROME_BIN)
  ) {
    return existing;
  }

  // Skip auto-download when explicitly disabled
  if (process.env.E2E_SKIP_GOOGLE_CHROME === "1") {
    return existing;
  }

  if (!canAutoDownloadGoogleChrome()) {
    return existing;
  }

  const script = join(__dirname, "tools/ensure-google-chrome.sh");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status === 0) {
    const path = (result.stdout || "").trim().split("\n").pop();
    if (path && existsSync(path)) {
      process.env.CHROME_BIN = path;
      process.env.GOOGLE_CHROME_BIN = path;
      return path;
    }
  } else {
    console.warn(
      "[ensure-browser] Google Chrome install failed; H.264 E2E may be skipped/failed.\n",
      result.stderr || result.stdout || result.error,
    );
  }
  return existing;
}

function hasPlaywrightChromium(packageName) {
  try {
    const { chromium } = require(packageName);
    const chromiumExecutablePath = chromium.executablePath();
    if (!existsSync(chromiumExecutablePath)) {
      return false;
    }

    const chromiumDir = dirname(dirname(chromiumExecutablePath));
    const revision = basename(chromiumDir).replace("chromium-", "");
    const headlessShellDir = join(
      dirname(chromiumDir),
      `chromium_headless_shell-${revision}`,
    );
    const headlessShellPaths = [
      join(
        headlessShellDir,
        "chrome-headless-shell-linux64",
        "chrome-headless-shell",
      ),
      join(headlessShellDir, "chrome-linux", "headless_shell"),
    ];

    return headlessShellPaths.some(existsSync);
  } catch (error) {
    return false;
  }
}

function installPlaywrightBrowsers(packageName, components) {
  const playwrightPackageJson = require.resolve(`${packageName}/package.json`, {
    paths: [__dirname],
  });
  const cliPath = join(dirname(playwrightPackageJson), "cli.js");
  const result = spawnSync(
    process.execPath,
    [cliPath, "install", ...components],
    { cwd: __dirname, stdio: "inherit" },
  );

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

const chrome = ensureGoogleChromeForH264();
if (chrome) {
  console.log(`[ensure-browser] using Chrome: ${chrome}`);
}

if (!hasPlaywrightChromium("playwright")) {
  // Regular and DTLS E2E both run on this package's pinned Chromium.
  installPlaywrightBrowsers("playwright", [
    "chromium",
    "chromium-headless-shell",
  ]);
}
