import { OverconstrainedError } from "../../src/errors";
import { useOPUS, useVP8 } from "../../src/media/codec";
import { MediaStream, MediaStreamTrack } from "../../src/media/track";
import { createCallbackRegister, installPolyfill } from "../../src/polyfill";

/** A track created directly, with an Opus codec (`sampleRate` / `channelCount`). */
export function arrangeOpusTrack() {
  return new MediaStreamTrack({ kind: "audio", codec: useOPUS() });
}

/** A video track created directly, with a VP8 codec. */
export function arrangeVp8Track() {
  return new MediaStreamTrack({ kind: "video", codec: useVP8() });
}

export function arrangeStream(tracks: MediaStreamTrack[]) {
  return new MediaStream(tracks);
}

/**
 * Install the polyfill with one VP8 callback register identified by
 * `deviceId` / `groupId`. Call `uninstall` in `finally`.
 */
export function arrangeIdentifiedVideoRegister() {
  const uninstall = installPolyfill({
    mediaRegister: [
      createCallbackRegister({
        mimeType: "video/VP8",
        kinds: ["video"],
        deviceId: "camera-1",
        groupId: "group-1",
        async createTracks() {
          return [new MediaStreamTrack({ kind: "video" })];
        },
      }),
    ],
  });
  return { uninstall };
}

/** Run `act` and return what it rejected with (`undefined` when it resolved). */
export async function captureRejection(act: () => Promise<unknown>) {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error;
  }
}

export function expectOverconstrained(error: unknown, constraint: string) {
  expect(error).toBeInstanceOf(OverconstrainedError);
  expect((error as OverconstrainedError).constraint).toBe(constraint);
}
