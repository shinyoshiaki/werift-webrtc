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
