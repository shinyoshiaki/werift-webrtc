const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");

function resolveSystemChrome() {
  return [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
}

function hasPlaywrightChromium() {
  try {
    const { chromium } = require("playwright");
    const chromiumExecutablePath = chromium.executablePath();
    if (!existsSync(chromiumExecutablePath)) {
      return false;
    }

    const chromiumDir = dirname(dirname(chromiumExecutablePath));
    const revision = basename(chromiumDir).replace("chromium-", "");
    const headlessShellPath = join(
      dirname(chromiumDir),
      `chromium_headless_shell-${revision}`,
      "chrome-linux",
      "headless_shell",
    );

    return existsSync(headlessShellPath);
  } catch {
    return false;
  }
}

if (resolveSystemChrome() || hasPlaywrightChromium()) {
  process.exit(0);
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  command,
  ["playwright", "install", "chromium", "chromium-headless-shell"],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
