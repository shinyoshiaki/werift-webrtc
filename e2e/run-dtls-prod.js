const { spawn } = require("node:child_process");
const { requestServerStop } = require("./stop");

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

function runDtlsMode(mode) {
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
      env: {
        ...process.env,
        DTLS_CHROMIUM_MODE: mode,
      },
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

  for (const mode of ["dtls12", "dtls13"]) {
    currentChild = runDtlsMode(mode);
    const result = await waitForExit(currentChild);
    const code = result.signal
      ? signalExitCode(result.signal)
      : (result.code ?? 1);
    if (requestedExitCode != null) {
      await requestServerStop();
      process.exit(requestedExitCode);
    }
    if (code !== 0) {
      await requestServerStop();
      process.exit(code);
    }
  }

  await requestServerStop();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
