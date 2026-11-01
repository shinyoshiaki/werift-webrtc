const { spawn } = require("node:child_process");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function main() {
  const silent = process.argv[2] === "silent";
  const child = spawn(npmCommand(), ["run", "chrome"], {
    cwd: __dirname,
    env: {
      ...process.env,
      EXAMPLES_E2E_SILENT: silent ? "1" : "",
    },
    stdio: "inherit",
  });

  let requestedExitCode;

  const stopRun = (signal) => {
    requestedExitCode ??= signalExitCode(signal);
    if (isRunning(child)) {
      child.kill(signal);
    }
  };

  process.once("SIGINT", () => stopRun("SIGINT"));
  process.once("SIGTERM", () => stopRun("SIGTERM"));

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  process.exit(
    requestedExitCode ??
      (result.signal ? signalExitCode(result.signal) : (result.code ?? 1)),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
