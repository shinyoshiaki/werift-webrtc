import { Readable } from "stream";

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

type ResolvedFile =
  | { path: string }
  | { buffer: Buffer }
  | { stream: Readable | ReadableStream<Uint8Array> };

/**
 * Synchronous factory. Container I/O and player setup run in `createTracks`,
 * so `installPolyfill({ mediaRegister: [createMp4WebmRegister({ path })] })`
 * matches the ticket contract and does not fail before install.
 */
export function createMp4WebmRegister(
  options: CreateMp4WebmRegisterOptions,
): MediaRegister {
  const snapshot = snapshotSource(options);
  let playerPromise:
    | Promise<Awaited<ReturnType<typeof createFileMediaPlayer>>>
    | undefined;
  let started = false;

  return {
    mimeType: mimeTypeFromContainer(snapshot.container, snapshot.kinds),
    kinds: snapshot.kinds,
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label,
    async createTracks(request: MediaGetUserMediaRequest) {
      const player = await getPlayer();
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
      void playerPromise?.then((player) => player.stop());
    },
  };

  async function getPlayer() {
    playerPromise ??= (async () => {
      const file = await resolveFile(snapshot);
      return createFileMediaPlayer({
        loop: options.loop,
        ...file,
      });
    })();
    return playerPromise;
  }
}

type SourceSnapshot = {
  file: ResolvedFile;
  container: "webm" | "mp4";
  kinds: MediaKind[];
};

function snapshotSource(options: CreateMp4WebmRegisterOptions): SourceSnapshot {
  if ("path" in options && options.path != undefined) {
    const container = containerFromPath(options.path);
    return {
      file: { path: options.path },
      container,
      kinds: kindsFromPath(options.path),
    };
  }
  if ("binary" in options && options.binary != undefined) {
    const buffer = toBuffer(options.binary);
    const container = isWebmContainer(buffer) ? "webm" : "mp4";
    return {
      file: { buffer },
      container,
      kinds: inspectKindsFromBuffer(buffer) ?? ["audio", "video"],
    };
  }
  const captured = tryCaptureEndedStream(options.stream);
  if (captured) {
    const container = isWebmContainer(captured) ? "webm" : "mp4";
    return {
      file: { buffer: captured },
      container,
      kinds: inspectKindsFromBuffer(captured) ?? ["audio", "video"],
    };
  }
  return {
    file: { stream: options.stream },
    container: "mp4",
    kinds: ["audio", "video"],
  };
}

async function resolveFile(snapshot: SourceSnapshot): Promise<ResolvedFile> {
  if ("stream" in snapshot.file) {
    const buffer = await readEntireStream(snapshot.file.stream);
    return { buffer };
  }
  return snapshot.file;
}

function kindsFromPath(path: string): MediaKind[] {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".m4a") ||
    lower.endsWith(".weba") ||
    lower.endsWith(".aac")
  ) {
    return ["audio"];
  }
  return ["audio", "video"];
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

function tryCaptureEndedStream(
  stream: Readable | ReadableStream<Uint8Array>,
): Buffer | undefined {
  if (!(stream instanceof Readable)) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let chunk: Buffer | string | null;
  while ((chunk = stream.read()) != null) {
    chunks.push(toBuffer(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return Buffer.concat(chunks);
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
