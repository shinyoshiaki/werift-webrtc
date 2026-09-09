import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { repoRoot } from "./paths.js";

const STOP_TIMEOUT_MS = 2_000;

export type SpawnedProcess = {
  child: ChildProcess;
  logs: string;
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export function hasExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function commandExists(command: string) {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  return paths.some((dir) => existsSync(path.join(dir, command)));
}

export function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve port")));
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

export async function waitForPortFree(port: number, timeoutMs = 15_000) {
  if (port <= 0) {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const free = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });
    if (free) {
      return;
    }
    await delay(200);
  }
  throw new Error(`port ${port} stayed occupied`);
}

export async function waitForPortOpen(port: number, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) {
      return;
    }
    await delay(150);
  }
  throw new Error(`timed out waiting for port ${port}`);
}

function resolveTsx() {
  const candidate = path.join(repoRoot, "node_modules", ".bin", "tsx");
  if (existsSync(candidate)) {
    return candidate;
  }
  return "npx";
}

export function spawnLogged(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): SpawnedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  const onData = (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    if (process.env.EXAMPLES_E2E_SILENT !== "1") {
      process.stdout.write(text);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const waitForExit = () =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        if (hasExited(child)) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

  return {
    child,
    get logs() {
      return logs;
    },
    waitForExit,
  };
}

export function spawnExampleTsx(
  entryFile: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  const tsx = resolveTsx();
  const args = tsx.endsWith("tsx")
    ? [entryFile]
    : ["tsx", entryFile];
  return spawnLogged(tsx, args, options);
}

export async function waitForLog(
  spawned: SpawnedProcess,
  match: string | RegExp,
  timeoutMs = 20_000,
) {
  const startedAt = Date.now();
  const matches = (text: string) =>
    typeof match === "string" ? text.includes(match) : match.test(text);

  while (Date.now() - startedAt < timeoutMs) {
    if (matches(spawned.logs)) {
      return;
    }
    if (hasExited(spawned.child)) {
      throw new Error(
        `process exited before log ${String(match)}: ${spawned.logs.slice(-2_000)}`,
      );
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for log ${String(match)}: ${spawned.logs.slice(-2_000)}`,
  );
}

export function spawnVideotestsrc(port: number, cwd: string) {
  const pipeline = [
    "videotestsrc",
    "video/x-raw,width=640,height=480,format=I420",
    "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
    "rtpvp8pay",
    `udpsink host=127.0.0.1 port=${port}`,
  ].join(" ! ");
  return spawnLogged("gst-launch-1.0", pipeline.split(" "), { cwd });
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (hasExited(child)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(hasExited(child));
    }, timeoutMs);
    const onDone = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onDone);
      child.off("error", onDone);
    };
    child.once("exit", onDone);
    child.once("error", onDone);
  });
}

export async function stopProcessTree(child?: ChildProcess) {
  if (!child || hasExited(child) || child.pid == null) {
    return;
  }
  const pid = child.pid;
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };

  killGroup("SIGINT");
  if (await waitForExit(child, STOP_TIMEOUT_MS)) {
    return;
  }
  killGroup("SIGTERM");
  if (await waitForExit(child, STOP_TIMEOUT_MS)) {
    return;
  }
  killGroup("SIGKILL");
  await waitForExit(child, STOP_TIMEOUT_MS);
}

const MEDIA_COMM = new Set(["gst-launch-1.0", "ffmpeg"]);

function readProcComm(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

export function isMediaBinaryPid(pid: number) {
  const comm = readProcComm(pid);
  return MEDIA_COMM.has(comm) || comm.startsWith("gst-launch");
}

export function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pgrep(args: string[]) {
  const listed = spawn("pgrep", args, { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise<string>((resolve) => {
    let text = "";
    listed.stdout?.on("data", (chunk) => {
      text += chunk.toString();
    });
    listed.on("close", () => resolve(text));
  });
}

function parsePids(output: string) {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return pids;
}

export async function listProcessGroupPids(pgid: number) {
  return parsePids(await pgrep(["-g", String(pgid)]));
}

export async function listMediaPids() {
  const names = ["gst-launch-1.0", "ffmpeg"];
  const pids = new Set<number>();
  for (const name of names) {
    for (const pid of parsePids(await pgrep(["-x", name]))) {
      pids.add(pid);
    }
  }
  return pids;
}

export async function listMediaPidsForProcesses(processes: SpawnedProcess[]) {
  const pids = new Set<number>();
  for (const spawned of processes) {
    const pid = spawned.child.pid;
    if (pid == null) {
      continue;
    }
    for (const candidate of await listProcessGroupPids(pid)) {
      if (isMediaBinaryPid(candidate)) {
        pids.add(candidate);
      }
    }
    if (isMediaBinaryPid(pid)) {
      pids.add(pid);
    }
  }
  return pids;
}

export async function waitForMediaPids(
  processes: SpawnedProcess[],
  options: { timeoutMs?: number; before?: Set<number> } = {},
) {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await listMediaPidsForProcesses(processes);
    if (options.before) {
      for (const pid of await listMediaPids()) {
        if (!options.before.has(pid)) {
          pids.add(pid);
        }
      }
    }
    if (pids.size > 0) {
      await delay(400);
      await assertMediaPidsAlive(pids);
      return pids;
    }
    for (const spawned of processes) {
      if (hasExited(spawned.child) && spawned.child.exitCode) {
        throw new Error(
          `example exited before gst/ffmpeg started: ${spawned.logs.slice(-2_000)}`,
        );
      }
    }
    await delay(150);
  }
  throw new Error("gst-launch-1.0 / ffmpeg did not start");
}

export async function assertMediaPidsAlive(pids: Iterable<number>) {
  const missing: number[] = [];
  for (const pid of pids) {
    if (!isPidAlive(pid)) {
      missing.push(pid);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `ffmpeg/GStreamer child exited immediately (pids ${missing.join(", ")})`,
    );
  }
}

export function watchUnexpectedExit(
  spawned: SpawnedProcess,
  options: { allowExit?: boolean } = {},
) {
  let unexpected: Error | undefined;
  const fail = (code: number | null, signal: NodeJS.Signals | null) => {
    if (options.allowExit) {
      return;
    }
    unexpected = new Error(
      `example process exited unexpectedly (code=${code} signal=${signal})\n${spawned.logs.slice(-2_000)}`,
    );
  };
  if (hasExited(spawned.child)) {
    fail(spawned.child.exitCode, spawned.child.signalCode);
  } else {
    spawned.child.once("exit", (code, signal) => fail(code, signal));
  }
  return {
    allowExit() {
      options.allowExit = true;
      unexpected = undefined;
    },
    throwIfExited() {
      if (unexpected) {
        throw unexpected;
      }
    },
  };
}

const FATAL_LOG = /Error: baseTime not exist|UnhandledPromiseRejection|unhandledRejection/;

export function assertGstreamerHealthy(
  spawned: SpawnedProcess,
  options: { requireExit?: boolean } = {},
) {
  const lines = spawned.logs.split("\n");
  const failures = lines.filter(
    (line) =>
      /gst (?:error|unexpected exit):/i.test(line) ||
      (/gst stderr:/i.test(line) && /error|critical|failed/i.test(line)) ||
      /gst exit code=(?!0(?:\s|$)|null(?:\s|$))/i.test(line),
  );
  if (failures.length > 0) {
    throw new Error(
      `GStreamer reported a failure:\n${failures.join("\n")}`,
    );
  }
  if (options.requireExit && !lines.some((line) => /gst exit code=/i.test(line))) {
    throw new Error(
      `GStreamer exit status was not reported:\n${spawned.logs.slice(-2_000)}`,
    );
  }
}

export function assertNoFatalLogs(spawned: SpawnedProcess) {
  if (FATAL_LOG.test(spawned.logs)) {
    throw new Error(
      `example logged a fatal error:\n${spawned.logs.slice(-2_000)}`,
    );
  }
}

export async function killPids(pids: Iterable<number>) {
  for (const pid of pids) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as NodeJS.Signals[]) {
      try {
        process.kill(pid, signal);
      } catch {
        break;
      }
      await delay(200);
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
    }
  }
}
