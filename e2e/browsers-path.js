const { join } = require("node:path");

// Keep the Playwright browsers for this harness out of the shared
// ~/.cache/ms-playwright directory. Other Playwright installs that share that
// directory (different versions, other checkouts) garbage-collect revisions
// they do not reference, which can delete our Chromium between install and
// launch. An explicit PLAYWRIGHT_BROWSERS_PATH from the caller still wins.
function ensurePlaywrightBrowsersPath() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(
    __dirname,
    "node_modules",
    ".cache",
    "ms-playwright",
  );
  return process.env.PLAYWRIGHT_BROWSERS_PATH;
}

module.exports = { ensurePlaywrightBrowsersPath };
