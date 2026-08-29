import type { MediaStreamTrack } from "../../media/track";
import {
  createDummyAudioTrack,
  createDummyVideoTrack,
} from "../../nonstandard/dummyMedia";
import type {
  MediaGetUserMediaRequest,
  MediaKind,
  MediaRegister,
  MediaRegisterCommonOptions,
} from "../mediaRegister";
import { bindTrackStop } from "../trackStop";

export type CreateCallbackRegisterOptions = MediaRegisterCommonOptions & {
  mimeType: string;
  kinds: readonly MediaKind[];
  createTracks: (
    request: MediaGetUserMediaRequest,
  ) => Promise<MediaStreamTrack[]>;
  stop?: () => void;
};

export function createCallbackRegister(
  options: CreateCallbackRegisterOptions,
): MediaRegister {
  return {
    mimeType: options.mimeType,
    kinds: options.kinds,
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label,
    createTracks: options.createTracks,
    stop: options.stop,
  };
}

export function createDummyRegister(
  options: MediaRegisterCommonOptions = {},
): MediaRegister {
  const stops: Array<() => void> = [];
  return createCallbackRegister({
    mimeType: "video/VP8",
    kinds: ["audio", "video"],
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label ?? "werift dummy media",
    async createTracks(request) {
      if (request.kind === "audio") {
        const dummy = createDummyAudioTrack();
        stops.push(() => dummy.source.stop());
        bindTrackStop(dummy.track, () => dummy.source.stop());
        return [dummy.track];
      }
      const dummy = createDummyVideoTrack();
      stops.push(() => dummy.source.stop());
      bindTrackStop(dummy.track, () => dummy.source.stop());
      return [dummy.track];
    },
    stop() {
      for (const stop of stops) {
        stop();
      }
      stops.length = 0;
    },
  });
}
