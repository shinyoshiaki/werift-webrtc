const net = require("node:net");
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

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("failed to resolve chrome-e2e harness port")),
        );
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

async function waitForServer(port) {
  const startedAt = Date.now();
  const timeoutMs = 30_000;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`chrome-e2e server did not become ready on port ${port}`);
}

async function main() {
  const mode = process.argv[2] === "silent" ? "silent" : "default";
  const port = String(await getAvailablePort());
  const env = {
    ...process.env,
    CHROME_E2E_PORT: port,
    VITE_CHROME_E2E_PORT: port,
  };
  const stdio = mode === "silent" ? ["ignore", "pipe", "pipe"] : "inherit";

  const server = spawn(npmCommand(), ["run", "server"], {
    cwd: __dirname,
    env,
    stdio,
  });

  if (stdio !== "inherit") {
    server.stdout?.pipe(process.stdout);
    server.stderr?.pipe(process.stderr);
  }

  let requestedExitCode;
  let stopPromise;

  const stopRun = async (signal) => {
    requestedExitCode ??= signalExitCode(signal);
    if (!stopPromise) {
      stopPromise = (async () => {
        if (isRunning(server)) {
          server.kill(signal);
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

  try {
    await waitForServer(port);
    const chrome = spawn(npmCommand(), ["run", "chrome"], {
      cwd: __dirname,
      env,
      stdio: "inherit",
    });
    const result = await waitForExit(chrome);
    await requestServerStop(port);
    process.exit(
      requestedExitCode ??
        (result.signal ? signalExitCode(result.signal) : (result.code ?? 1)),
    );
  } finally {
    if (isRunning(server)) {
      await requestServerStop(port);
    }
  }
}

main().catch(async (error) => {
  console.error(error);
  await requestServerStop(process.env.CHROME_E2E_PORT ?? "8887").catch(
    () => undefined,
  );
  process.exit(1);
});
