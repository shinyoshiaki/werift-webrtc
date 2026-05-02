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

async function main() {
  const child = spawn(
    npmCommand(),
    [
      "exec",
      "--",
      "vitest",
      "run",
      "./tests",
      "--browser.headless",
      "--reporter=dot",
    ],
    {
      cwd: __dirname,
      env: process.env,
      stdio: "inherit",
    },
  );

  let requestedExitCode;
  let stopPromise;

  const stopRun = async (signal) => {
    requestedExitCode ??= signalExitCode(signal);

    if (!stopPromise) {
      stopPromise = (async () => {
        if (isRunning(child)) {
          child.kill(signal);
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

  const result = await waitForExit(child);
  await requestServerStop();

  process.exit(
    requestedExitCode ??
      (result.signal ? signalExitCode(result.signal) : (result.code ?? 1)),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
