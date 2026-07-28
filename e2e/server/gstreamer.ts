import { type ChildProcess, spawn, spawnSync } from "child_process";

const STOP_TIMEOUT_MS = 2_000;

/** True when gst-launch-1.0 is on PATH (mediachannel e2e needs it). */
export function isGstreamerAvailable(): boolean {
  const result = spawnSync("gst-launch-1.0", ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

const activeProcesses = new Set<ChildProcess>();
const stopPromises = new WeakMap<ChildProcess, Promise<void>>();

function hasExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

function registerProcess(child: ChildProcess) {
  activeProcesses.add(child);

  const unregister = () => {
    activeProcesses.delete(child);
    stopPromises.delete(child);
  };

  child.once("exit", unregister);
  child.once("error", unregister);

  return child;
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(hasExited(child));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopWithSignal(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
) {
  if (hasExited(child)) {
    return true;
  }

  child.kill(signal);
  return waitForExit(child, timeoutMs);
}

export function spawnGstreamerPipeline(pipeline: string[]) {
  return registerProcess(
    spawn("gst-launch-1.0", pipeline.join(" ! ").split(" ")),
  );
}

export function stopGstreamerProcess(child?: ChildProcess) {
  if (!child || hasExited(child)) {
    return Promise.resolve();
  }

  const activeStop = stopPromises.get(child);
  if (activeStop) {
    return activeStop;
  }

  const stopPromise = (async () => {
    if (await stopWithSignal(child, "SIGINT", STOP_TIMEOUT_MS)) {
      return;
    }

    if (await stopWithSignal(child, "SIGTERM", STOP_TIMEOUT_MS)) {
      return;
    }

    child.kill("SIGKILL");
    await waitForExit(child, STOP_TIMEOUT_MS);
  })();

  stopPromises.set(child, stopPromise);
  return stopPromise;
}

export async function cleanupGstreamerProcesses() {
  await Promise.all(
    [...activeProcesses].map((child) => stopGstreamerProcess(child)),
  );
}
