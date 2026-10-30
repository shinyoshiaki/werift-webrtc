// Shared Playwright browser installer. Run once from the repo root via
// `npm run install:browsers`. Nested chrome-e2e / e2e helpers reuse this file.
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { playwrightInstallEnv } = require("./playwright-host-platform.js");

const repoRoot = join(__dirname, "..");

// e2e keeps its browsers in a package-local path and has its own installer.
const e2eDir = join(repoRoot, "e2e");

const playwrightPackageDirs = [
  repoRoot,
  join(repoRoot, "packages/ice-server/chrome-e2e"),
  join(repoRoot, "examples/turn-loopback/chrome-e2e"),
];

function resolveSystemChrome() {
  return [
    process.env.CHROME_BIN,
    process.env.GOOGLE_CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
}

function resolveFromPackage(packageDir, request) {
  try {
    return require(require.resolve(request, { paths: [packageDir] }));
  } catch {
    return null;
  }
}

function hasHeadlessShell(chromiumExecutablePath) {
  const chromiumDir = dirname(dirname(chromiumExecutablePath));
  const revision = basename(chromiumDir).replace("chromium-", "");
  const headlessRoot = join(
    dirname(chromiumDir),
    `chromium_headless_shell-${revision}`,
  );

  return [
    join(
      headlessRoot,
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    ),
    join(headlessRoot, "chrome-linux", "headless_shell"),
    join(headlessRoot, "chrome-mac", "headless_shell"),
    join(headlessRoot, "chrome-mac-arm64", "headless_shell"),
    join(headlessRoot, "chrome-win64", "headless_shell.exe"),
    join(headlessRoot, "chrome-win", "headless_shell.exe"),
  ].some((candidate) => existsSync(candidate));
}

/**
 * Browsers directory a harness launches from: its `browsers-path.js`
 * (kept out of the shared cache) unless the caller set PLAYWRIGHT_BROWSERS_PATH.
 */
function harnessBrowsersPath(packageDir) {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return undefined;
  }
  const helper = join(packageDir, "browsers-path.js");
  if (!existsSync(helper)) {
    return undefined;
  }
  return join(packageDir, "node_modules", ".cache", "ms-playwright");
}

function hasPlaywrightChromium(playwright, browsersPath) {
  try {
    let chromiumExecutablePath = playwright.chromium.executablePath();
    if (browsersPath) {
      // Same revision and layout, rooted at the harness browsers directory.
      const chromiumDir = dirname(dirname(chromiumExecutablePath));
      chromiumExecutablePath = join(
        browsersPath,
        chromiumExecutablePath.slice(dirname(chromiumDir).length + 1),
      );
    }
    return (
      existsSync(chromiumExecutablePath) &&
      hasHeadlessShell(chromiumExecutablePath)
    );
  } catch {
    return false;
  }
}

function installWithPlaywright(packageDir, browsersPath) {
  const packageJsonPath = require.resolve("playwright/package.json", {
    paths: [packageDir],
  });
  const cliPath = join(dirname(packageJsonPath), "cli.js");
  const installEnv = playwrightInstallEnv();
  const result = spawnSync(
    process.execPath,
    [cliPath, "install", "chromium", "chromium-headless-shell"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: browsersPath
        ? { ...installEnv, PLAYWRIGHT_BROWSERS_PATH: browsersPath }
        : installEnv,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function collectPlaywrightInstalls() {
  const installs = [];
  const seenVersions = new Set();

  for (const packageDir of playwrightPackageDirs) {
    const manifest = resolveFromPackage(packageDir, "playwright/package.json");
    const playwright = resolveFromPackage(packageDir, "playwright");
    if (!manifest?.version || !playwright) {
      continue;
    }
    const browsersPath = harnessBrowsersPath(packageDir);
    const key = `${manifest.version}:${browsersPath ?? ""}`;
    if (seenVersions.has(key)) {
      continue;
    }
    seenVersions.add(key);
    installs.push({
      packageDir,
      playwright,
      version: manifest.version,
      browsersPath,
    });
  }

  return installs;
}

function main() {
  // System Chrome is enough for most browser tests, but DTLS version
  // tests need Playwright's pinned Chromium. Set FORCE_PLAYWRIGHT_BROWSERS=1
  // to install it even when /usr/bin/google-chrome exists (GHA ubuntu-latest).
  if (resolveSystemChrome() && process.env.FORCE_PLAYWRIGHT_BROWSERS !== "1") {
    process.exit(0);
  }

  const installs = collectPlaywrightInstalls();
  if (installs.length === 0) {
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const result = spawnSync(
      command,
      ["playwright", "install", "chromium", "chromium-headless-shell"],
      {
        cwd: repoRoot,
        env: playwrightInstallEnv(),
        stdio: "inherit",
      },
    );
    if (result.error) {
      throw result.error;
    }
    process.exit(result.status ?? 1);
  }

  for (const install of installs) {
    if (hasPlaywrightChromium(install.playwright, install.browsersPath)) {
      continue;
    }
    installWithPlaywright(install.packageDir, install.browsersPath);
  }

  if (resolveFromPackage(e2eDir, "playwright/package.json")) {
    const result = spawnSync(
      process.execPath,
      [join(e2eDir, "ensure-browser.js")],
      { cwd: e2eDir, stdio: "inherit" },
    );
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  process.exit(0);
}

main();
