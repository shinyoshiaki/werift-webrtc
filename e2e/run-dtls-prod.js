const { spawn } = require("node:child_process");
const { requestServerStop } = require("./stop");
const { ensurePlaywrightBrowsersPath } = require("./browsers-path");

// Launch the Chromium that ensure-browser.js installed for this harness.
ensurePlaywrightBrowsersPath();

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function runDtls() {
  return spawn(
    npmCommand(),
    [
      "exec",
      "--",
      "vitest",
      "run",
      "--config",
      "vitest.dtls.config.mts",
      "--browser.headless",
      "--reporter=dot",
    ],
    {
      cwd: __dirname,
      env: process.env,
      stdio: "inherit",
    },
  );
}

async function main() {
  let requestedExitCode;
  let currentChild;
  let stopPromise;

  const stopRun = async (signal) => {
    requestedExitCode ??= signalExitCode(signal);
    if (!stopPromise) {
      stopPromise = (async () => {
        if (currentChild && isRunning(currentChild)) {
          currentChild.kill(signal);
        }
        await requestServerStop();
      })();
    }
    await stopPromise;
  };

  process.once("SIGINT", () => {
    void stopRun("SIGINT").catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.once("SIGTERM", () => {
    void stopRun("SIGTERM").catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });

  currentChild = runDtls();
  const result = await waitForExit(currentChild);
  const code = result.signal
    ? signalExitCode(result.signal)
    : (result.code ?? 1);
  await requestServerStop();
  process.exit(requestedExitCode ?? code);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
