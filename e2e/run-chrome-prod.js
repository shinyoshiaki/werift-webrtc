const { spawn, spawnSync } = require("node:child_process");
const { requestServerStop } = require("./stop");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function isGstreamerAvailable() {
  const result = spawnSync("gst-launch-1.0", ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
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
  const vitestArgs = [
    "exec",
    "--",
    "vitest",
    "run",
    "./tests",
    "--browser.headless",
    "--reporter=dot",
  ];
  // mediachannel e2e spawns gst-launch-1.0 on the server host.
  // Skip those suites when gstreamer is not installed (CI sandbox).
  if (!isGstreamerAvailable()) {
    console.warn(
      "gstreamer (gst-launch-1.0) not found; excluding tests/mediachannel/** from e2e",
    );
    vitestArgs.push("--exclude", "**/mediachannel/**");
  }

  const child = spawn(npmCommand(), vitestArgs, {
    cwd: __dirname,
    env: process.env,
    stdio: "inherit",
  });

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
