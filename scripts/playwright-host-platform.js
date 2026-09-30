// Playwright rejects `install` on Ubuntu releases newer than its latest
// supported LTS (e.g. "does not support chromium on ubuntu26.04-x64"), even
// though the Linux Chromium builds are identical across Ubuntu releases.
// Map such hosts to the newest supported Ubuntu build for installation only.
const { readFileSync } = require("node:fs");

const LATEST_SUPPORTED_UBUNTU = "24.04";

function readOsRelease() {
  try {
    const entries = readFileSync("/etc/os-release", "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^"|"$/g, "")]);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function resolveHostPlatformOverride() {
  if (process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
    return undefined;
  }
  if (
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch)
  ) {
    return undefined;
  }
  const osRelease = readOsRelease();
  const major = Number.parseInt(osRelease.VERSION_ID ?? "", 10);
  if (osRelease.ID !== "ubuntu" || !(major > 24)) {
    return undefined;
  }
  return `ubuntu${LATEST_SUPPORTED_UBUNTU}-${process.arch}`;
}

function playwrightInstallEnv() {
  const override = resolveHostPlatformOverride();
  if (!override) {
    return process.env;
  }
  console.log(
    `[playwright] host is not supported by Playwright; installing ${override} browser builds`,
  );
  return { ...process.env, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: override };
}

module.exports = { playwrightInstallEnv };
