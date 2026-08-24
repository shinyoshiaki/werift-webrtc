import { createFileMediaPlayer } from "../../nonstandard/userMedia";
import type {
  MediaGetUserMediaRequest,
  MediaRegister,
  MediaRegisterCommonOptions,
} from "../mediaRegister";
import { type BinaryLike, isWebmContainer, toBuffer } from "../sourceIo";
import { bindTrackStop } from "../trackStop";

type Mp4WebmSource =
  | { path: string; binary?: never; stream?: never }
  | { path?: never; binary: BinaryLike; stream?: never }
  | {
      path?: never;
      binary?: never;
      stream: import("stream").Readable | ReadableStream<Uint8Array>;
    };

export type CreateMp4WebmRegisterOptions = Mp4WebmSource &
  MediaRegisterCommonOptions & {
    loop?: boolean;
  };

export function createMp4WebmRegister(
  options: CreateMp4WebmRegisterOptions,
): MediaRegister {
  const mimeType = inferContainerMimeType(options);
  let playerPromise:
    | Promise<Awaited<ReturnType<typeof createFileMediaPlayer>>>
    | undefined;
  let started = false;

  return {
    mimeType,
    kinds: ["audio", "video"],
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label,
    async createTracks(request: MediaGetUserMediaRequest) {
      const player = await getPlayer();
      const track = request.kind === "audio" ? player.audio : player.video;
      if (!track) {
        throw new Error(`mp4/webm source has no ${request.kind} track`);
      }
      bindTrackStop(track, () => player.stop());
      if (!started) {
        started = true;
        void player.start();
      }
      return [track];
    },
    stop() {
      void playerPromise?.then((player) => player.stop());
    },
  };

  async function getPlayer() {
    playerPromise ??= createFileMediaPlayer({
      loop: options.loop,
      ...toFileSource(options),
    });
    return playerPromise;
  }
}

function toFileSource(options: CreateMp4WebmRegisterOptions) {
  if ("path" in options && options.path != undefined) {
    return { path: options.path };
  }
  if ("binary" in options && options.binary != undefined) {
    return { buffer: toBuffer(options.binary) };
  }
  return { stream: options.stream };
}

function inferContainerMimeType(options: CreateMp4WebmRegisterOptions): string {
  if ("path" in options && typeof options.path === "string") {
    const lower = options.path.toLowerCase();
    if (lower.endsWith(".webm")) {
      return "video/webm";
    }
    if (lower.endsWith(".m4a")) {
      return "audio/mp4";
    }
    return "video/mp4";
  }
  if ("binary" in options && options.binary != undefined) {
    const buffer = toBuffer(options.binary);
    return isWebmContainer(buffer) ? "video/webm" : "video/mp4";
  }
  return "video/mp4";
}
