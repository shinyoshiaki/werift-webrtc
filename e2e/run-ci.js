const net = require("node:net");
const { spawn } = require("node:child_process");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
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

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
