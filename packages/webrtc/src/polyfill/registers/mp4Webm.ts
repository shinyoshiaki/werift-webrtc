import type { Readable } from "stream";

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
      stream: Readable | ReadableStream<Uint8Array>;
    };

export type CreateMp4WebmRegisterOptions = Mp4WebmSource &
  MediaRegisterCommonOptions & {
    loop?: boolean;
  };

type FilePlayer = Awaited<ReturnType<typeof createFileMediaPlayer>>;

/**
 * Synchronous factory. Container I/O and player setup run in `prepare` /
 * `createTracks`, so install does not open files or consume live streams.
 */
export function createMp4WebmRegister(
  options: CreateMp4WebmRegisterOptions,
): MediaRegister {
  let mimeType = initialMimeType(options);
  const kinds: MediaKind[] = [...initialKinds(options)];
  let playerPromise: Promise<FilePlayer> | undefined;
  let started = false;
  const ioAbort = new AbortController();

  const register: MediaRegister = {
    get mimeType() {
      return mimeType;
    },
    get kinds() {
      return kinds;
    },
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label,
    async prepare() {
      await getPlayer();
    },
    async createTracks(request: MediaGetUserMediaRequest) {
      const player = await getPlayer(request.signal);
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
        void player.start().catch(() => undefined);
      }
      return [track];
    },
    stop() {
      ioAbort.abort();
      void playerPromise?.then(
        (player) => player.stop(),
        () => undefined,
      );
    },
  };
  return register;

  async function getPlayer(signal?: AbortSignal) {
    const onAbort = () => ioAbort.abort();
    if (signal?.aborted) {
      ioAbort.abort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    playerPromise ??= (async () => {
      try {
        const file = await resolveFile(options, ioAbort.signal);
        const player = await createFileMediaPlayer({
          loop: options.loop,
          ...file,
        });
        applyInspectedMetadata(file, player);
        return player;
      } catch (error) {
        throw mapMediaIoError(error);
      }
    })();
    try {
      return await playerPromise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  function applyInspectedMetadata(
    file: { path: string } | { buffer: Buffer },
    player: FilePlayer,
  ) {
    kinds.splice(0, kinds.length, ...kindsFromPlayer(player));
    const container = containerOf(
      options,
      "buffer" in file ? file.buffer : undefined,
    );
    mimeType = mimeTypeFromContainer(container, kinds);
  }
}

function initialKinds(options: CreateMp4WebmRegisterOptions): MediaKind[] {
  if ("binary" in options && options.binary != undefined) {
    return (
      inspectKindsFromBuffer(toBuffer(options.binary)) ?? ["audio", "video"]
    );
  }
  return ["audio", "video"];
}

function initialMimeType(options: CreateMp4WebmRegisterOptions): string {
  const kinds = initialKinds(options);
  return mimeTypeFromContainer(containerOf(options), kinds);
}

function containerOf(
  options: CreateMp4WebmRegisterOptions,
  buffer?: Buffer,
): "webm" | "mp4" {
  if (buffer) {
    return isWebmContainer(buffer) ? "webm" : "mp4";
  }
  if ("path" in options && options.path != undefined) {
    return containerFromPath(options.path);
  }
  if ("binary" in options && options.binary != undefined) {
    return isWebmContainer(toBuffer(options.binary)) ? "webm" : "mp4";
  }
  return "mp4";
}

async function resolveFile(
  options: CreateMp4WebmRegisterOptions,
  signal: AbortSignal,
): Promise<{ path: string } | { buffer: Buffer }> {
  if ("path" in options && options.path != undefined) {
    return { path: options.path };
  }
  if ("binary" in options && options.binary != undefined) {
    return { buffer: toBuffer(options.binary) };
  }
  return { buffer: await readEntireStream(options.stream, signal) };
}

function kindsFromPlayer(player: FilePlayer): MediaKind[] {
  const next: MediaKind[] = [];
  if (player.audio) {
    next.push("audio");
  }
  if (player.video) {
    next.push("video");
  }
  return next;
}

function containerFromPath(path: string): "webm" | "mp4" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".webm") || lower.endsWith(".weba")) {
    return "webm";
  }
  return "mp4";
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

function inspectKindsFromBuffer(buffer: Buffer): MediaKind[] | undefined {
  try {
    const kinds = isWebmContainer(buffer)
      ? inspectWebmKinds(buffer)
      : inspectMp4Kinds(buffer);
    return kinds.length > 0 ? kinds : undefined;
  } catch {
    return undefined;
  }
}

function inspectMp4Kinds(buffer: Buffer): MediaKind[] {
  const found = new Set<MediaKind>();
  for (let index = 4; index < buffer.length - 16; index++) {
    if (buffer.toString("ascii", index, index + 4) !== "hdlr") {
      continue;
    }
    const handler = buffer.toString("ascii", index + 12, index + 16);
    if (handler === "soun") {
      found.add("audio");
    } else if (handler === "vide") {
      found.add("video");
    }
  }
  return [...found];
}

function inspectWebmKinds(buffer: Buffer): MediaKind[] {
  const found = new Set<MediaKind>();
  for (let index = 0; index < buffer.length - 2; index++) {
    if (buffer[index] !== 0x83 || buffer[index + 1] !== 0x81) {
      continue;
    }
    const trackType = buffer[index + 2];
    if (trackType === 0x01) {
      found.add("video");
    } else if (trackType === 0x02) {
      found.add("audio");
    }
  }
  return [...found];
}

function mapMediaIoError(error: unknown) {
  if (error instanceof DOMException) {
    return error;
  }
  return createWebRtcDomException(
    "NotReadableError",
    error instanceof Error ? error.message : "Failed to read media source",
  );
}
