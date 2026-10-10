import { MediaStreamTrack } from "../../media/track";
import type {
  MediaKind,
  MediaRegister,
  MediaRegisterCommonOptions,
} from "../mediaRegister";

const EMPTY_MIME_TYPE_BY_KIND: Readonly<Record<MediaKind, string>> =
  Object.freeze({
    audio: "audio/opus",
    video: "video/VP8",
  });

export function createEmptyRegister(
  options: MediaRegisterCommonOptions = {},
): MediaRegister {
  const kinds = ["audio", "video"] as const satisfies readonly MediaKind[];
  return {
    mimeType: defaultMimeTypeForKinds(kinds),
    mimeTypeByKind: EMPTY_MIME_TYPE_BY_KIND,
    kinds,
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label ?? "werift empty media",
    async createTracks(request) {
      return [new MediaStreamTrack({ kind: request.kind })];
    },
  };
}

function defaultMimeTypeForKinds(kinds: readonly MediaKind[]): string {
  return kinds.includes("video")
    ? EMPTY_MIME_TYPE_BY_KIND.video
    : EMPTY_MIME_TYPE_BY_KIND.audio;
}
