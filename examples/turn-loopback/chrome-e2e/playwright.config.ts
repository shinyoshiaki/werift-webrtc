import { existsSync } from "node:fs";

import type { BrowserContextOptions, LaunchOptions } from "playwright";

const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));

export const chromiumLaunchOptions: LaunchOptions = {
  ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
  args: ["--ignore-certificate-errors", "--allow-insecure-localhost"],
};

export const chromiumContextOptions: BrowserContextOptions = {
  ignoreHTTPSErrors: true,
};
