import type { Readable } from "stream";

import { OverconstrainedError, createWebRtcDomException } from "../../errors";
import { RTCRtpCodecParameters } from "../../media/parameters";
import type { MediaStreamTrack } from "../../media/track";
import { createFileMediaPlayer } from "../../nonstandard/userMedia";
import type {
  MediaGetUserMediaRequest,
  MediaKind,
  MediaRegister,
  MediaRegisterCommonOptions,
} from "../mediaRegister";
import {
  type RtpCodecFromMimeTypeOptions,
  rtpCodecFromMimeType,
} from "../rtpCodec";
import {
  type BinaryLike,
  isWebmContainer,
  readEntireStream,
  toBuffer,
} from "../sourceIo";
import { bindOwnTrackStop } from "../trackStop";

type Mp4WebmSource =
  | { path: string; binary?: never; stream?: never }
  | { path?: never; binary: BinaryLike; stream?: never }
  | {
      path?: never;
      binary?: never;
      stream: Readable | ReadableStream<Uint8Array>;
    };

export type Mp4WebmCodecHint =
  | string
  | RtpCodecFromMimeTypeOptions
  | RTCRtpCodecParameters;

export type CreateMp4WebmRegisterOptions = Mp4WebmSource &
  MediaRegisterCommonOptions & {
    loop?: boolean;
    /**
     * RTP codecs advertised on acquired tracks.
     * Omitted kinds are filled from the container via mediabunny.
     */
    codecs?: {
      audio?: Mp4WebmCodecHint;
      video?: Mp4WebmCodecHint;
    };
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
  let resolvedFile: { path: string } | { buffer: Buffer } | undefined;
  let started = false;
  const liveTracks = new Set<MediaStreamTrack>();
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
      const source = request.kind === "audio" ? player.audio : player.video;
      if (!source) {
        throw createWebRtcDomException(
          "NotFoundError",
          `mp4/webm source has no ${request.kind} track`,
        );
      }
      const track = source.clone();
      applyInspectedOrExplicitCodec(
        source,
        track,
        request.kind,
        options.codecs?.[request.kind],
      );
      liveTracks.add(track);
      bindOwnTrackStop(track, () => {
        liveTracks.delete(track);
        if (liveTracks.size === 0) {
          releasePlayer();
        }
      });
      if (!started) {
        started = true;
        void player.start().catch(() => undefined);
      }
      return [track];
    },
    stop() {
      ioAbort.abort();
      for (const track of [...liveTracks]) {
        track.stop();
      }
      liveTracks.clear();
      releasePlayer();
    },
  };
  return register;

  function releasePlayer() {
    started = false;
    const pending = playerPromise;
    playerPromise = undefined;
    void pending?.then(
      (player) => player.stop(),
      () => undefined,
    );
  }

  async function getPlayer(signal?: AbortSignal) {
    const onAbort = () => ioAbort.abort();
    if (signal?.aborted) {
      ioAbort.abort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    playerPromise ??= (async () => {
      try {
        resolvedFile ??= await resolveFile(options, ioAbort.signal);
        const player = await createFileMediaPlayer({
          loop: options.loop,
          ...resolvedFile,
        });
        applyInspectedMetadata(resolvedFile, player);
        return player;
      } catch (error) {
        playerPromise = undefined;
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

function applyInspectedOrExplicitCodec(
  source: MediaStreamTrack,
  track: MediaStreamTrack,
  kind: MediaKind,
  hint: Mp4WebmCodecHint | undefined,
) {
  const inspected = source.codec;
  if (hint == undefined) {
    if (inspected == undefined) {
      throw createWebRtcDomException(
        "NotReadableError",
        `mp4/webm source has no RTP codec for ${kind}`,
      );
    }
    track.codec = inspected;
    return;
  }
  const explicit = resolveMp4WebmCodecHint(hint);
  if (
    inspected &&
    inspected.mimeType.toLowerCase() !== explicit.mimeType.toLowerCase()
  ) {
    throw new OverconstrainedError(
      "mimeType",
      `explicit ${kind} codec ${explicit.mimeType} does not match inspected ${inspected.mimeType}`,
    );
  }
  source.codec = explicit;
  track.codec = explicit;
}

function resolveMp4WebmCodecHint(
  hint: Mp4WebmCodecHint,
): RTCRtpCodecParameters {
  if (typeof hint === "string") {
    return rtpCodecFromMimeType({ mimeType: hint });
  }
  if (hint instanceof RTCRtpCodecParameters) {
    return hint;
  }
  return rtpCodecFromMimeType(hint);
}
