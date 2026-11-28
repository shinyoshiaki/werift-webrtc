/**
 * Runs the Firefox E2E suite (vitest.firefox.config.mts) and saves a run
 * record with the commit hash (see `firefox-runs/README.md`).
 *
 *   cd e2e && npm run firefox:record                      # whole suite, local
 *   cd e2e && npm run firefox:record -- tests/bundle      # vitest filters/args
 *   cd e2e && npm run firefox:ci                          # CI mode (--ci)
 *
 * Local runs save the record under `firefox-runs/` and prune records beyond
 * the newest `FIREFOX_RECORDS_KEEP` (default 20, `firefox-runs-prune.js`).
 * The `firefox-e2e` job of `.github/workflows/nodejs.yml` runs the suite with
 * `--ci`: the record goes outside the repository (`FIREFOX_RECORDS_DIR`, else
 * `$RUNNER_TEMP/firefox-runs`) for the job to upload as an artifact, nothing
 * is pruned, and the default time limit is 20 min instead of 60.
 *
 * Starts the e2e server (TypeScript sources, as `npm run server`) on a free
 * port, installs Playwright Firefox into the harness's browser cache when it
 * is missing, runs vitest, and stops the server through its `/stop` endpoint,
 * then by PID. The record is written however the run ends: vitest exits, the
 * time limit (`FIREFOX_E2E_TIMEOUT_MIN`) or no test event for
 * `FIREFOX_E2E_IDLE_MIN` (default 5) stops it, or SIGINT / SIGTERM stops the
 * runner. The exit code is 0 only for a passed record (completed, vitest
 * exited with 0, no unfinished test or module error); otherwise vitest's code
 * (1 on a time limit, 130 / 143 on a signal).
 */
const net = require("node:net");
const os = require("node:os");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { dirname, join, relative, resolve } = require("node:path");

const { ensureBrowsersPathEnv } = require("./ensure-browser");
const { requestServerStop } = require("./stop");
const { keepFromEnv, pruneRecords } = require("./firefox-runs-prune");
const {
  buildRecord,
  collectGitInfo,
  recordFileName,
  runOptions,
  runnerExitCode,
  summarizeEvents,
} = require("./firefox-run-record");

const repoRoot = resolve(__dirname, "..");
// A test stuck past its own testTimeout (seen in Firefox) stops the whole
// run: no reporter event for `idleMin` stops it too. The slowest test with
// its retry takes about a minute.
const { vitestArgs, recordsDir, prune, timeoutMin, idleMin, label } =
  runOptions(process.argv.slice(2), process.env, {
    repoRoot,
    tmpdir: os.tmpdir(),
  });

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRunning(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
}

function getAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForPort(port, child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isRunning(child)) {
      throw new Error("e2e server exited before it listened");
    }
    const connected = await new Promise((r) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => r(true));
      socket.once("error", () => r(false));
      socket.unref();
    });
    if (connected) return;
    if (Date.now() > deadline) {
      throw new Error(`e2e server did not listen on ${port}`);
    }
    await sleep(500);
  }
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    if (!isRunning(child)) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

/**
 * SIGTERM by PID, then SIGKILL when it is still running after `graceMs`. A
 * child spawned `detached` leads its own process group, which is signalled as
 * a whole (vitest's Firefox processes included), still by PID, never by name.
 */
async function stopChild(child, graceMs = 10_000) {
  if (!isRunning(child)) return;
  const signal = (name) => {
    try {
      if (child.detached) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  const exited = await Promise.race([
    waitForExit(child).then(() => true),
    sleep(graceMs).then(() => false),
  ]);
  if (!exited) signal("SIGKILL");
}

/** Installs Playwright Firefox into PLAYWRIGHT_BROWSERS_PATH when missing. */
function ensureFirefox(env) {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "process.stdout.write(require('playwright').firefox.executablePath())",
    ],
    { cwd: __dirname, env, encoding: "utf8" },
  );
  if (probe.status === 0 && existsSync(probe.stdout.trim())) return;
  console.log(`[${label}] installing Playwright Firefox`);
  const install = spawnSync(
    npmCommand(),
    ["exec", "--", "playwright", "install", "firefox"],
    { cwd: __dirname, env, stdio: "inherit" },
  );
  if (install.status !== 0) {
    throw new Error("playwright install firefox failed");
  }
}

/** Browser and tool versions of the run (null when unavailable). */
function collectEnvironment(env) {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `require('playwright').firefox.launch().then(async (b) => {
         process.stdout.write(b.version()); await b.close();
       }).catch(() => process.exit(1))`,
    ],
    { cwd: __dirname, env, encoding: "utf8", timeout: 60_000 },
  );
  const packageVersion = (name) => {
    try {
      return require(`${name}/package.json`).version;
    } catch {
      return null;
    }
  };
  return {
    firefox: probe.status === 0 ? probe.stdout.trim() : null,
    playwright: packageVersion("playwright"),
    vitest: packageVersion("vitest"),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  };
}

async function main() {
  const env = { ...process.env };
  ensureBrowsersPathEnv(env);
  ensureFirefox(env);

  const git = collectGitInfo((args) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }),
  );
  const environment = collectEnvironment(env);
  const port = String(await getAvailablePort());
  const eventsFile = join(
    os.tmpdir(),
    `werift-firefox-e2e-${process.pid}.ndjson`,
  );
  rmSync(eventsFile, { force: true });
  env.E2E_PORT = port;
  env.VITE_E2E_PORT = port;
  env.FIREFOX_RECORD_EVENTS = eventsFile;

  console.log(
    `[${label}] commit ${git.shortCommit}${git.dirty ? " (+uncommitted changes)" : ""}, ` +
      `Firefox ${environment.firefox ?? "unknown"}, e2e port ${port}, limit ${timeoutMin} min (idle ${idleMin} min)`,
  );
  const startedAt = new Date();
  let outcome = "completed";
  let stopReason = null;
  let exitCode = 1;
  let server;
  let vitest;

  // Writes the record once, however the run ends, after stopping the children.
  let finishing;
  const finish = () => {
    finishing ??= (async () => {
      await stopChild(vitest);
      await requestServerStop(port).catch(() => {});
      if (isRunning(server)) {
        // The server's own stop path first, then by PID (never by pattern).
        const exited = await Promise.race([
          waitForExit(server).then(() => true),
          sleep(10_000).then(() => false),
        ]);
        if (!exited) await stopChild(server);
      }
      const finishedAt = new Date();
      const events = existsSync(eventsFile)
        ? readFileSync(eventsFile, "utf8")
        : "";
      rmSync(eventsFile, { force: true });
      const record = buildRecord({
        git,
        startedAt,
        finishedAt,
        exitCode,
        outcome,
        stopReason,
        vitestArgs,
        environment,
        summary: summarizeEvents(events, repoRoot),
      });
      const dir = recordsDir;
      mkdirSync(dir, { recursive: true });
      const name = recordFileName(record);
      writeFileSync(join(dir, name), `${JSON.stringify(record, null, 2)}\n`);
      const { totals } = record;
      console.log(
        `[${label}] ${record.result} (${outcome}): ${totals.passed} passed, ` +
          `${totals.failed} failed, ${totals.skipped} skipped, ${totals.unfinished} unfinished ` +
          `of ${totals.files} files`,
      );
      for (const test of record.unfinished) {
        console.log(`[${label}] unfinished: ${test.file} > ${test.name}`);
      }
      for (const error of record.moduleErrors) {
        console.log(`[${label}] module error: ${JSON.stringify(error)}`);
      }
      console.log(
        `[${label}] record saved: ${relative(process.cwd(), join(dir, name)) || name}`,
      );
      // CI keeps its record as an artifact and never prunes.
      if (!prune) return runnerExitCode(record);
      // Keep the newest records only (the one just saved always stays).
      try {
        const pruned = pruneRecords(dir, Math.max(1, keepFromEnv()));
        if (pruned.length) {
          console.log(
            `[${label}] pruned ${pruned.length} old record(s), keeping the newest ${Math.max(1, keepFromEnv())}`,
          );
        }
      } catch (error) {
        console.error(`[${label}] prune skipped: ${error.message}`);
      }
      return runnerExitCode(record);
    })();
    return finishing;
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => {
      if (outcome === "completed") outcome = "interrupted";
      exitCode = code;
      void finish().finally(() => process.exit(code));
    });
  }

  try {
    // Same command as `npm run server`, spawned directly so its PID is the
    // server's own (a PID stop then reaches it, not just an npm wrapper).
    server = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--import",
        "../tools/node-ts/register.mjs",
        "./server/main.ts",
      ],
      { cwd: __dirname, env, stdio: ["ignore", "inherit", "inherit"] },
    );
    await waitForPort(Number(port), server);
    // No "./tests" path filter by default: vitest's include in the config
    // limits discovery (a substring filter would also match simulations/tests).
    vitest = spawn(
      process.execPath,
      [
        join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
        "run",
        "--browser.headless",
        "--config",
        "vitest.firefox.record.config.mts",
        ...vitestArgs,
      ],
      // Own process group, so stopping it also stops its browsers.
      { cwd: __dirname, env, stdio: "inherit", detached: true },
    );
    vitest.detached = true;
    let timer;
    let watchdog;
    const result = await Promise.race([
      waitForExit(vitest),
      new Promise((r) => {
        timer = setTimeout(() => r("limit"), timeoutMin * 60_000);
      }),
      new Promise((r) => {
        let size = -1;
        let changedAt = Date.now();
        watchdog = setInterval(() => {
          const now = existsSync(eventsFile) ? statSync(eventsFile).size : 0;
          if (now !== size) {
            size = now;
            changedAt = Date.now();
          } else if (Date.now() - changedAt > idleMin * 60_000) {
            r("idle");
          }
        }, 10_000);
      }),
    ]);
    clearTimeout(timer);
    clearInterval(watchdog);
    if (result === "limit" || result === "idle") {
      stopReason =
        result === "limit"
          ? `vitest did not finish in ${timeoutMin} min (FIREFOX_E2E_TIMEOUT_MIN)`
          : `no test event for ${idleMin} min (FIREFOX_E2E_IDLE_MIN)`;
      console.error(`[${label}] ${stopReason}; stopping vitest`);
      outcome = "timeout";
      exitCode = 1;
    } else if (outcome === "completed") {
      exitCode = result.code ?? 1;
    }
  } catch (error) {
    console.error(`[${label}]`, error);
    if (outcome === "completed") outcome = "error";
    exitCode = 1;
  }
  process.exit(await finish());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
