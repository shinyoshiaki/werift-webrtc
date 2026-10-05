import { readFileSync } from "fs";

import { BufferSource, Input, MP4 } from "mediabunny";

import { MP4Callback, type Track } from "../src/extra";
import type { Mp4Output } from "../src/extra/processor/mp4";
import {
  RtpMediaClock,
  type RtpMediaClockOptions,
  type RtpMediaClockTick,
} from "../src/rtp/mediaClock";
import type { Transport } from "../src/transport";

export function load(name: string) {
  const base = __dirname;
  const data = readFileSync(`${base}/data/` + name);
  return data;
}

export function createMockTransportPair(): [Transport, Transport] {
  class Mock implements Transport {
    onData!: (buf: Buffer) => void;
    target!: Mock;

    send(buf: Buffer) {
      this.target.onData(buf);
    }
    close() {}
  }

  const a = new Mock();
  const b = new Mock();
  a.target = b;
  b.target = a;

  return [a, b];
}

export async function collectMp4Buffer(
  tracks: Track[],
  act: (mp4: MP4Callback) => void | Promise<void>,
) {
  const outputs = await collectMp4Outputs(tracks, act);
  const chunks = outputs
    .filter((output): output is Extract<Mp4Output, { data: Uint8Array }> => {
      return "data" in output;
    })
    .map((output) => output.data);

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function collectMp4Outputs(
  tracks: Track[],
  act: (mp4: MP4Callback) => void | Promise<void>,
  options: {
    callbackDelay?: number;
  } = {},
) {
  const outputs: Mp4Output[] = [];
  const mp4 = new MP4Callback(tracks);

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  mp4.pipe(async (output) => {
    if (options.callbackDelay) {
      await sleep(options.callbackDelay);
    }
    outputs.push(output);
    if ("eol" in output && output.eol) {
      resolveDone();
    }
  });

  try {
    await act(mp4);
    await withTimeout(done, 5_000);
  } catch (error) {
    rejectDone(error as Error);
    throw error;
  }

  return outputs;
}

export function createMp4Input(buffer: Buffer) {
  return new Input({
    source: new BufferSource(buffer),
    formats: [MP4],
  });
}

async function withTimeout<T>(promise: Promise<T>, timeout: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${timeout}ms`));
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sleep(timeout: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeout);
  });
}

/**
 * Virtual monotonic clock + scheduler for deterministic `RtpMediaClock` tests.
 *
 * - `advance(ms)`: moves time forward and fires due timers in deadline order.
 * - `block(ms)`: moves time forward without firing timers (stalled event loop).
 * - `callbackLatency`: every timer fires this many ms after its due time.
 */
export function createManualMediaClockHarness(
  options: { startTime?: number; callbackLatency?: number } = {},
) {
  const callbackLatency = options.callbackLatency ?? 0;
  let currentTime = options.startTime ?? 0;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();

  const now = () => currentTime;
  const scheduler = {
    setTimeout(cb: () => void, ms: number) {
      const handle = ++nextHandle;
      timers.set(handle, { at: currentTime + ms + callbackLatency, cb });
      return handle;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
  };

  const fireDueTimers = (until: number) => {
    for (;;) {
      let due: [number, { at: number; cb: () => void }] | undefined;
      for (const entry of timers) {
        if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) {
          due = entry;
        }
      }
      if (!due) {
        return;
      }
      timers.delete(due[0]);
      currentTime = Math.max(currentTime, due[1].at);
      due[1].cb();
    }
  };

  const advance = (ms: number) => {
    const target = currentTime + ms;
    fireDueTimers(target);
    currentTime = target;
  };

  const block = (ms: number) => {
    currentTime += ms;
  };

  const createClock = (
    clockOptions: Omit<RtpMediaClockOptions, "now" | "scheduler">,
  ) => new RtpMediaClock({ ...clockOptions, now, scheduler });

  const collectTicks = (clock: RtpMediaClock) => {
    const ticks: RtpMediaClockTick[] = [];
    clock.onTick.subscribe((tick) => {
      ticks.push(tick);
    });
    return ticks;
  };

  return {
    now,
    scheduler,
    advance,
    block,
    createClock,
    collectTicks,
    pendingTimerCount: () => timers.size,
  };
}

/** Counts active Node.js `Timeout` resources. */
export function activeTimeoutCount() {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout")
    .length;
}

/** Real-timer scheduler that records every handle it creates. */
export function createRecordingScheduler() {
  const handles: ReturnType<typeof setTimeout>[] = [];
  return {
    handles,
    scheduler: {
      setTimeout(cb: () => void, ms: number) {
        const handle = setTimeout(cb, ms);
        handles.push(handle);
        return handle;
      },
      clearTimeout(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
  };
}
