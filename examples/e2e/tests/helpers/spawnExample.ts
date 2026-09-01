import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

function hasExited(child: ChildProcess) {
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

export async function listMediaPids() {
  const names = ["gst-launch-1.0", "ffmpeg"];
  const pids = new Set<number>();
  for (const name of names) {
    const listed = spawn("pgrep", ["-x", name], { stdio: ["ignore", "pipe", "ignore"] });
    const output = await new Promise<string>((resolve) => {
      let text = "";
      listed.stdout?.on("data", (chunk) => {
        text += chunk.toString();
      });
      listed.on("close", () => resolve(text));
    });
    for (const line of output.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  }
  return pids;
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
