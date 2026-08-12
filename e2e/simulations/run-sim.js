/**
 * werift↔Chrome 帯域シミュレーション実行ランナー（CI 対象外）。
 * サーバと vitest を並列起動し、テスト終了後にサーバを停止する。
 *
 * PLAYWRIGHT_BROWSERS_PATH は ensure-browser.js と同じ worktree ローカル
 * キャッシュへ揃え、`npm run install:browsers` 後の `npm run test:sim` が
 * 明示 export なしでも Chromium を見つけられるようにする。
 */
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ensureBrowsersPathEnv } = require("../ensure-browser");
const { requestServerStop } = require("../stop");

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
  const port = String(await getAvailablePort());
  const env = {
    ...process.env,
    E2E_PORT: port,
    VITE_E2E_PORT: port,
  };
  // Align Playwright cache with install:browsers / run-ci / run-chrome-prod.
  const browsersPath = ensureBrowsersPathEnv(env);
  const cwd = path.join(__dirname, "..");

  console.log(`using e2e sim port ${port}`);
  console.log(`using PLAYWRIGHT_BROWSERS_PATH=${browsersPath}`);

  const server = spawn(npmCommand(), ["run", "server:silent"], {
    cwd,
    env,
    stdio: "inherit",
  });

  // サーバ起動待ち
  await new Promise((r) => setTimeout(r, 1500));

  const chrome = spawn(npmCommand(), ["run", "chrome:sim"], {
    cwd,
    env,
    stdio: "inherit",
  });

  let requestedExitCode;

  const shutdown = async (signal) => {
    if (signal) {
      requestedExitCode ??= signalExitCode(signal);
    }
    if (isRunning(chrome)) {
      chrome.kill(signal || "SIGTERM");
    }
    if (isRunning(server)) {
      server.kill(signal || "SIGTERM");
    }
    await requestServerStop(port);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });

  const result = await waitForExit(chrome);
  await shutdown();

  // サーバ終了を少し待つ
  if (isRunning(server)) {
    await Promise.race([
      waitForExit(server),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }

  process.exit(
    requestedExitCode ??
      (result.signal ? signalExitCode(result.signal) : (result.code ?? 1)),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
