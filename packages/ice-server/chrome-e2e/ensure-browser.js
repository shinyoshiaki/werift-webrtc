const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

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
  const home = process.env.HOME;
  if (!home) {
    return false;
  }

  try {
    return readdirSync(join(home, ".cache", "ms-playwright")).some((entry) =>
      entry.startsWith("chromium-"),
    );
  } catch (error) {
    return false;
  }
}

if (resolveSystemChrome() || hasPlaywrightChromium()) {
  process.exit(0);
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["playwright", "install", "chromium"], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
