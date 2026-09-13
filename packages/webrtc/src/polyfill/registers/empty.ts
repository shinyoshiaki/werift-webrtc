import { MediaStreamTrack } from "../../media/track";
import type {
  MediaRegister,
  MediaRegisterCommonOptions,
} from "../mediaRegister";

export function createEmptyRegister(
  options: MediaRegisterCommonOptions = {},
): MediaRegister {
  return {
    mimeType: "video/VP8",
    kinds: ["audio", "video"],
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label ?? "werift empty media",
    async createTracks(request) {
      return [new MediaStreamTrack({ kind: request.kind })];
    },
  };
}
