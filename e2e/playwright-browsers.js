// Keep e2e Playwright browsers out of the shared ~/.cache/ms-playwright.
// Playwright garbage-collects that shared cache on every install and drops
// browsers whose registering package path is not visible from the installing
// process (e.g. another checkout or a container with a different filesystem
// view). That can delete this package's pinned Chromium between
// `install:browsers` and the DTLS suite. A package-local browsers path is only
// touched by installs from this package.
const { join } = require("node:path");

const E2E_PLAYWRIGHT_BROWSERS_PATH = join(
  __dirname,
  "node_modules",
  ".cache",
  "ms-playwright",
);

function withE2ePlaywrightBrowsersPath(env = process.env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    return env;
  }
  return { ...env, PLAYWRIGHT_BROWSERS_PATH: E2E_PLAYWRIGHT_BROWSERS_PATH };
}

// Must run before `playwright` is loaded: its registry resolves the browsers
// path once at module load.
function applyE2ePlaywrightBrowsersPath() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= E2E_PLAYWRIGHT_BROWSERS_PATH;
}

module.exports = {
  E2E_PLAYWRIGHT_BROWSERS_PATH,
  applyE2ePlaywrightBrowsersPath,
  withE2ePlaywrightBrowsersPath,
};
