const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { requestServerStop } = require("./stop");

const exampleDir = path.resolve(__dirname, "..");

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
          reject(new Error("failed to resolve turn-loopback chrome-e2e port")),
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

function spawnCommand(cwd, args, env, stdio) {
  return spawn(npmCommand(), args, {
    cwd,
    env,
    stdio,
  });
}

function runCommand(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(cwd, args, env, "inherit");
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`command exited with signal ${signal}: npm ${args.join(" ")}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`command exited with code ${code}: npm ${args.join(" ")}`));
        return;
      }
      resolve();
    });
  });
}

function request(url) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      url.startsWith("https:")
        ? { rejectUnauthorized: false }
        : undefined,
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            ok: (response.statusCode ?? 500) < 400,
            statusCode: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
  });
}

async function waitForUrl(url) {
  const startedAt = Date.now();
  const timeoutMs = 30_000;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await request(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out waiting for ${url}`);
}

function stopChild(child, signal = "SIGTERM") {
  if (isRunning(child)) {
    child.kill(signal);
  }
}

async function main() {
  const mode = process.argv[2] === "silent" ? "silent" : "default";
  const serverPort = String(await getAvailablePort());
  const devClientPort = String(await getAvailablePort());
  const serverBaseUrl = `https://127.0.0.1:${serverPort}`;
  const devClientBaseUrl = `http://127.0.0.1:${devClientPort}`;
  const baseEnv = {
    ...process.env,
    TURN_LOOPBACK_HOST: "0.0.0.0",
    TURN_LOOPBACK_PORT: serverPort,
    TURN_LOOPBACK_E2E_SERVER_PORT: serverPort,
    TURN_LOOPBACK_E2E_SERVER_BASE_URL: serverBaseUrl,
    TURN_LOOPBACK_E2E_DEV_BASE_URL: devClientBaseUrl,
  };
  const serverStdio = mode === "silent" ? ["ignore", "pipe", "pipe"] : "inherit";

  await runCommand(exampleDir, ["run", "build"], baseEnv);

  const server = spawnCommand(exampleDir, ["run", "server"], baseEnv, serverStdio);
  if (serverStdio !== "inherit") {
    server.stdout?.pipe(process.stdout);
    server.stderr?.pipe(process.stderr);
  }

  let devClient;
  let requestedExitCode;
  let stopPromise;

  const stopRun = async (signal) => {
    requestedExitCode ??= signalExitCode(signal);
    if (!stopPromise) {
      stopPromise = (async () => {
        stopChild(devClient, signal);
        await requestServerStop(serverPort);
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
    await waitForUrl(`${serverBaseUrl}/health`);

    devClient = spawnCommand(
      exampleDir,
      [
        "run",
        "client",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        devClientPort,
        "--strictPort",
      ],
      {
        ...baseEnv,
        VITE_SIGNALING_BASE_URL: "https://127.0.0.1:65535",
      },
      serverStdio,
    );
    if (serverStdio !== "inherit") {
      devClient.stdout?.pipe(process.stdout);
      devClient.stderr?.pipe(process.stderr);
    }

    await waitForUrl(devClientBaseUrl);

    const chrome = spawnCommand(
      __dirname,
      ["run", "chrome"],
      {
        ...baseEnv,
        TURN_LOOPBACK_E2E_SERVER_BASE_URL: serverBaseUrl,
        TURN_LOOPBACK_E2E_DEV_BASE_URL: devClientBaseUrl,
      },
      "inherit",
    );
    const result = await waitForExit(chrome);

    await requestServerStop(serverPort);
    stopChild(devClient);

    process.exit(
      requestedExitCode ??
        (result.signal ? signalExitCode(result.signal) : (result.code ?? 1)),
    );
  } finally {
    stopChild(devClient);
    await requestServerStop(serverPort).catch(() => undefined);
    stopChild(server);
  }
}

main().catch(async (error) => {
  console.error(error);
  await requestServerStop(process.env.TURN_LOOPBACK_E2E_SERVER_PORT ?? "8443").catch(
    () => undefined,
  );
  process.exit(1);
});
