import { createWebRtcDomException } from "../../errors";
import { createFileMediaPlayer } from "../../nonstandard/userMedia";
import type {
  MediaGetUserMediaRequest,
  MediaKind,
  MediaRegister,
  MediaRegisterCommonOptions,
} from "../mediaRegister";
import {
  type BinaryLike,
  isWebmContainer,
  readEntireStream,
  toBuffer,
} from "../sourceIo";
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

export async function createMp4WebmRegister(
  options: CreateMp4WebmRegisterOptions,
): Promise<MediaRegister> {
  const resolved = await resolveSource(options);
  const player = await createFileMediaPlayer({
    loop: options.loop,
    ...resolved.file,
  });
  const kinds = kindsFromPlayer(player);
  const mimeType = mimeTypeFromContainer(resolved.container, kinds);
  let started = false;

  return {
    mimeType,
    kinds,
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label,
    async createTracks(request: MediaGetUserMediaRequest) {
      const track = request.kind === "audio" ? player.audio : player.video;
      if (!track) {
        throw createWebRtcDomException(
          "NotFoundError",
          `mp4/webm source has no ${request.kind} track`,
        );
      }
      bindTrackStop(track, () => player.stop());
      if (!started) {
        started = true;
        void player.start();
      }
      return [track];
    },
    stop() {
      void player.stop();
    },
  };
}

function kindsFromPlayer(
  player: Awaited<ReturnType<typeof createFileMediaPlayer>>,
): MediaKind[] {
  const kinds: MediaKind[] = [];
  if (player.audio) {
    kinds.push("audio");
  }
  if (player.video) {
    kinds.push("video");
  }
  return kinds;
}

async function resolveSource(options: CreateMp4WebmRegisterOptions) {
  if ("path" in options && options.path != undefined) {
    return {
      file: { path: options.path },
      container: containerFromPath(options.path),
    };
  }
  if ("binary" in options && options.binary != undefined) {
    const buffer = toBuffer(options.binary);
    return {
      file: { buffer },
      container: isWebmContainer(buffer) ? ("webm" as const) : ("mp4" as const),
    };
  }
  const buffer = await readEntireStream(options.stream);
  return {
    file: { buffer },
    container: isWebmContainer(buffer) ? ("webm" as const) : ("mp4" as const),
  };
}

function mimeTypeFromContainer(
  container: "webm" | "mp4",
  kinds: readonly MediaKind[],
): string {
  const hasVideo = kinds.includes("video");
  if (container === "webm") {
    return hasVideo ? "video/webm" : "audio/webm";
  }
  return hasVideo ? "video/mp4" : "audio/mp4";
}

function containerFromPath(path: string): "webm" | "mp4" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".webm") || lower.endsWith(".weba")) {
    return "webm";
  }
  return "mp4";
}
