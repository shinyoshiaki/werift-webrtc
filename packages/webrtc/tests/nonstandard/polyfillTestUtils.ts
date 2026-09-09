import { spawnSync } from "child_process";
import { createSocket } from "dgram";
import path from "path";
import { PassThrough } from "stream";

import { OverconstrainedError } from "../../src/errors";
import { MediaStreamTrack } from "../../src/media/track";
import {
  type MediaRegister,
  createCallbackRegister,
  installPolyfill,
} from "../../src/polyfill";
import { setUdpSocketFactory } from "../../src/polyfill/sourceIo";

const TYPESCRIPT_COMPILE_TIMEOUT_MS = 20_000;

export function compilePolyfillFixture(fixtureName: string) {
  const project = path.join(__dirname, fixtureName);
  const tsc = require.resolve("typescript/bin/tsc");
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", project, "--pretty", "false"],
    {
      encoding: "utf8",
      timeout: TYPESCRIPT_COMPILE_TIMEOUT_MS,
    },
  );

  if (result.error) {
    const reason =
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ? `TypeScript compiler timed out after ${TYPESCRIPT_COMPILE_TIMEOUT_MS}ms`
        : `TypeScript compiler failed to start: ${result.error.message}`;
    throw new Error(reason, { cause: result.error });
  }

  return result;
}

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

export function createH264CallbackRegister(
  overrides: Partial<Parameters<typeof createCallbackRegister>[0]> = {},
): MediaRegister {
  return createCallbackRegister({
    mimeType: "video/H264",
    kinds: ["video"],
    async createTracks() {
      return [new MediaStreamTrack({ kind: "video" })];
    },
    ...overrides,
  });
}

export async function arrangePolyfillVideoTrack(register: MediaRegister) {
  const uninstall = installTestPolyfill([register]);
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  return {
    uninstall,
    stream,
    track: stream.getVideoTracks()[0] as MediaStreamTrack,
  };
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

export async function withUdpSocketCounter<T>(
  run: (sockets: { created: number; open: () => number }) => Promise<T>,
): Promise<T> {
  const sockets: Array<{ closed: boolean }> = [];
  setUdpSocketFactory(() => {
    const socket = createSocket("udp4");
    const rec = { closed: false };
    socket.once("close", () => {
      rec.closed = true;
    });
    sockets.push(rec);
    return socket;
  });
  try {
    return await run({
      get created() {
        return sockets.length;
      },
      open() {
        return sockets.filter((socket) => !socket.closed).length;
      },
    });
  } finally {
    setUdpSocketFactory();
  }
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
