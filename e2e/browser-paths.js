const { existsSync } = require("node:fs");
const { join } = require("node:path");

const CACHED_CHROME = join(
  __dirname,
  ".cache/google-chrome/opt/google/chrome/google-chrome",
);

/**
 * The auto-downloaded package is the Linux amd64 .deb only. Elsewhere (macOS,
 * arm64, ...) it would extract an unrunnable binary, so do not use it.
 */
function canAutoDownloadGoogleChrome(
  platform = process.platform,
  arch = process.arch,
) {
  return platform === "linux" && arch === "x64";
}

function resolveSystemChrome(env = process.env, exists = existsSync) {
  return [
    env.CHROME_BIN,
    env.GOOGLE_CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && exists(candidate));
}

function resolveCachedGoogleChrome({
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
} = {}) {
  if (!canAutoDownloadGoogleChrome(platform, arch)) {
    return undefined;
  }
  return exists(CACHED_CHROME) ? CACHED_CHROME : undefined;
}

/**
 * Chrome executable for the E2E browser (explicit env > extracted cache >
 * system). Single source for ensure-browser.js and vitest.config.mts.
 */
function resolveChromeExecutable({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
} = {}) {
  const explicit = [env.CHROME_BIN, env.GOOGLE_CHROME_BIN].find(
    (candidate) => candidate && exists(candidate),
  );
  return (
    explicit ||
    resolveCachedGoogleChrome({ platform, arch, exists }) ||
    resolveSystemChrome(env, exists)
  );
}

module.exports = {
  canAutoDownloadGoogleChrome,
  resolveCachedGoogleChrome,
  resolveChromeExecutable,
  resolveSystemChrome,
};
