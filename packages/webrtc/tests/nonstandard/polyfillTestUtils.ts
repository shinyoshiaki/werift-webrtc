import { readFileSync, readdirSync, readlinkSync } from "fs";
import { PassThrough } from "stream";

import { OverconstrainedError } from "../../src/errors";
import { MediaStreamTrack } from "../../src/media/track";
import {
  type MediaRegister,
  createCallbackRegister,
  installPolyfill,
} from "../../src/polyfill";

export function installTestPolyfill(mediaRegister: MediaRegister[]) {
  return installPolyfill({ mediaRegister });
}

export function createVideoCallbackRegister(
  overrides: Partial<Parameters<typeof createCallbackRegister>[0]> = {},
): MediaRegister {
  return createCallbackRegister({
    mimeType: "video/VP8",
    kinds: ["video"],
    async createTracks() {
      return [new MediaStreamTrack({ kind: "video" })];
    },
    ...overrides,
  });
}

export function expectDomException(error: unknown, name: string) {
  expect(error).toBeInstanceOf(DOMException);
  expect((error as DOMException).name).toBe(name);
}

export function expectOverconstrainedError(error: unknown, constraint: string) {
  expect(error).toBeInstanceOf(OverconstrainedError);
  expect(error).toBeInstanceOf(DOMException);
  expect((error as OverconstrainedError).constraint).toBe(constraint);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function createHangingWebStream() {
  return new ReadableStream<Uint8Array>({
    pull() {
      // never enqueue or close; lock is held until cancel()
    },
  });
}

export function createHangingNodeStream() {
  return new PassThrough();
}

export function countProcessUdpSockets(pid = process.pid) {
  const tables = ["udp", "udp6"].flatMap((name) => {
    try {
      return readFileSync(`/proc/net/${name}`, "utf8").split("\n").slice(1);
    } catch {
      return [];
    }
  });
  const inodes = new Set<string>();
  for (const line of tables) {
    const inode = line.trim().split(/\s+/)[9];
    if (inode && inode !== "0") {
      inodes.add(inode);
    }
  }
  let count = 0;
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && inodes.has(match[1])) {
          count++;
        }
      } catch {
        // fd disappeared
      }
    }
  } catch {
    return count;
  }
  return count;
}

export async function waitForRtp(
  track: MediaStreamTrack,
  count = 1,
  timeoutMs = 3_000,
) {
  const packets: Buffer[] = [];
  return new Promise<Buffer[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      unSubscribe();
      reject(new Error(`Timed out waiting for ${count} RTP packets`));
    }, timeoutMs);
    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      packets.push(rtp.serialize());
      if (packets.length >= count) {
        clearTimeout(timer);
        unSubscribe();
        resolve(packets);
      }
    });
  });
}
