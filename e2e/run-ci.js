const net = require("node:net");
const { spawn } = require("node:child_process");
const { ensureBrowsersPathEnv } = require("./ensure-browser");
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

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve E2E port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function main() {
  const mode = process.argv[2] === "prod" ? "prod" : "silent";
  const port = String(await getAvailablePort());
  const env = {
    ...process.env,
    E2E_PORT: port,
    VITE_E2E_PORT: port,
  };
  ensureBrowsersPathEnv(env);
  const serverScript = mode === "prod" ? "server:prod" : "server:silent";

  console.log(`using e2e port ${port}`);

  const child = spawn(
    npmCommand(),
    ["exec", "run-p", serverScript, "chrome:prod"],
    {
      cwd: __dirname,
      env,
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

        await requestServerStop(port);
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
  await requestServerStop(port);

  process.exit(
    requestedExitCode ??
      (result.signal ? signalExitCode(result.signal) : (result.code ?? 1)),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
