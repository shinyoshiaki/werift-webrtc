import { randomUUID } from "crypto";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { Readable } from "stream";
import { readFile } from "fs/promises";
import {
  setImmediate as onNextTurn,
  setTimeout as wait,
} from "timers/promises";

import {
  BufferSource,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputTrack,
  type InputVideoTrack,
  MP4,
  WEBM,
} from "mediabunny";

import { Event } from "../imports/common";
import type { RTCRtpCodecParameters } from "../media/parameters";
import { MediaStreamTrack } from "../media/track";
import {
  useAV1X,
  useH264,
  useOPUS,
  useVP8,
  useVP9,
} from "../media/codec";
import { codecParametersFromString } from "../sdp";
import {
  type SupportedSourceCodec,
  createPacketizer,
  supportedSourceCodecs,
  toSupportedMimeType,
} from "./userMedia/packetizer";

type UserMediaSource =
  | { path: string; buffer?: never; stream?: never }
  | {
      path?: never;
      buffer: Buffer | ArrayBuffer | ArrayBufferView;
      stream?: never;
    }
  | {
      path?: never;
      buffer?: never;
      stream: Readable | ReadableStream<Uint8Array>;
    };

export type FileMediaTrackSource = UserMediaSource & {
  loop?: boolean;
};

export const createFileMediaPlayer = async (options: FileMediaTrackSource) => {
  assertSupportedOptions(options);
  const replayableSource = await createReplayableSource(options);
  const input = await createInput(replayableSource);
  try {
    if (!(await input.canRead())) {
      throw new Error("Only MP4 and WebM file playback is supported");
    }

    const streamId = randomUUID().toString();
    const playbackTracks = await selectPlaybackTracks(input, streamId);
    if (playbackTracks.length === 0) {
      throw new Error(
        "The media source does not contain playable audio or video tracks",
      );
    }

    const mediaStartTimestamp = await input.getFirstTimestamp(
      playbackTracks.map(({ inputTrack }) => inputTrack),
    );

    return new MediaPlayer({
      source: replayableSource,
      loop: options.loop ?? false,
      streamId,
      session: createPlaybackSession({
        input,
        mediaStartTimestamp,
        playbackTracks,
      }),
    });
  } catch (error) {
    input.dispose();
    throw error;
  }
};

class MediaPlayer {
  readonly audio?: MediaStreamTrack;
  readonly video?: MediaStreamTrack;
  readonly onError = new Event<[Error]>();

  private readonly source: ReplayableUserMediaSource;
  private readonly loop: boolean;
  private readonly streamId: string;
  private session?: PlaybackSession;
  private running?: Promise<void>;
  private abortController?: AbortController;
  private hasStartedPlayback = false;
  private stopped = false;

  constructor({
    source,
    loop,
    streamId,
    session,
  }: {
    source: ReplayableUserMediaSource;
    loop: boolean;
    streamId: string;
    session: PlaybackSession;
  }) {
    this.source = source;
    this.loop = loop;
    this.streamId = streamId;
    this.session = session;

    this.audio = session.playbackTracks.find(
      ({ track }) => track.kind === "audio",
    )?.track;
    this.video = session.playbackTracks.find(
      ({ track }) => track.kind === "video",
    )?.track;
  }

  async start() {
    if (this.stopped) {
      throw new Error("The media source has already been stopped");
    }
    if (this.running) {
      return;
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    let startupPending = true;
    let session: PlaybackSession | undefined;
    const playback = (async () => {
      session = await this.getOrCreateSession();
      if (abortController.signal.aborted || this.stopped) {
        return;
      }

      session.runners.forEach((runner) => runner.assertReady());

      const initialSourceChanged = this.hasStartedPlayback;
      this.hasStartedPlayback = true;
      await this.run(session, abortController, initialSourceChanged);
    })();
    const observedPlayback = playback.catch((error) => {
      if (abortController.signal.aborted) {
        return;
      }

      this.onError.execute(toError(error));
      if (startupPending) {
        throw error;
      }
    });

    this.running = observedPlayback.finally(() => {
      if (this.abortController === abortController) {
        this.abortController = undefined;
      }
      this.running = undefined;
      this.disposeSession(session);
    });

    try {
      await Promise.race([this.running, onNextTurn()]);
    } finally {
      startupPending = false;
    }
  }

  stop() {
    if (this.stopped) {
      return;
    }
    // File playback mirrors the previous process-backed behavior: stop() is terminal.
    this.stopped = true;
    this.abortController?.abort();
    if (!this.running) {
      this.disposeSession();
    }
  }

  private async run(
    session: PlaybackSession,
    abortController: AbortController,
    initialSourceChanged: boolean,
  ) {
    let sourceChanged = initialSourceChanged;

    do {
      const startedAt = performance.now();
      await Promise.all(
        session.runners.map((runner) =>
          runner.play({
            startedAt,
            signal: abortController.signal,
            sourceChanged,
          }),
        ),
      );
      if (!this.loop || abortController.signal.aborted) {
        break;
      }
      sourceChanged = true;
    } while (!abortController.signal.aborted);
  }

  private async getOrCreateSession() {
    if (this.session) {
      return this.session;
    }

    const input = await createInput(this.source);
    try {
      if (!(await input.canRead())) {
        throw new Error("Only MP4 and WebM file playback is supported");
      }

      const playbackTracks = await selectPlaybackTracks(
        input,
        this.streamId,
        buildExistingTrackMap(this.audio, this.video),
      );
      const mediaStartTimestamp = await input.getFirstTimestamp(
        playbackTracks.map(({ inputTrack }) => inputTrack),
      );

      const session = createPlaybackSession({
        input,
        mediaStartTimestamp,
        playbackTracks,
      });
      this.session = session;
      return session;
    } catch (error) {
      input.dispose();
      throw error;
    }
  }

  private disposeSession(session = this.session) {
    if (!session) {
      return;
    }

    session.input.dispose();
    if (this.session === session) {
      this.session = undefined;
    }
  }
}

class TrackPlaybackRunner {
  constructor(
    private readonly props: PlaybackTrack & {
      mediaStartTimestamp: number;
    },
  ) {}

  async play({
    startedAt,
    signal,
    sourceChanged,
  }: {
    startedAt: number;
    signal: AbortSignal;
    sourceChanged: boolean;
  }) {
    const codec = this.requireNegotiatedCodec();
    const packetizer = createPacketizer({
      codec,
      sourceCodec: this.props.sourceCodec,
      decoderDescription: this.props.decoderDescription,
    });
    const packetSink = new EncodedPacketSink(this.props.inputTrack);
    let sourceChangeNotified = false;

    try {
      for await (const packet of packetSink.packets(undefined, undefined, {
        verifyKeyPackets: this.props.track.kind === "video",
      })) {
        signal.throwIfAborted?.();

        const dueAtMs =
          (packet.timestamp - this.props.mediaStartTimestamp) * 1_000;
        const remainingMs = dueAtMs - (performance.now() - startedAt);
        if (remainingMs > 0) {
          await wait(remainingMs, undefined, { signal });
        }

        const rtpTimestamp = toRtpTimestamp(
          packet.timestamp,
          this.props.mediaStartTimestamp,
          codec.clockRate,
        );
        const packets = packetizer.packetize(packet, rtpTimestamp);
        if (packets.length === 0) {
          continue;
        }

        if (sourceChanged && !sourceChangeNotified) {
          this.props.track.onSourceChanged.execute(packets[0].header);
          sourceChangeNotified = true;
        }

        for (const rtpPacket of packets) {
          this.props.track.writeRtp(rtpPacket);
        }
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      throw error;
    }
  }

  assertReady() {
    const codec = this.requireNegotiatedCodec();
    createPacketizer({
      codec,
      sourceCodec: this.props.sourceCodec,
      decoderDescription: this.props.decoderDescription,
    });
  }

  private requireNegotiatedCodec() {
    const codec = this.props.track.codec;
    if (!codec) {
      throw new Error(
        `Cannot start ${this.props.track.kind} playback before the track is attached to an RTCRtpSender`,
      );
    }

    const expectedMimeType = toSupportedMimeType(this.props.sourceCodec);
    const negotiatedMimeType = normalizeMimeType(codec.mimeType);
    if (negotiatedMimeType !== expectedMimeType) {
      throw new Error(
        `Input ${this.props.track.kind} codec ${expectedMimeType} does not match negotiated codec ${codec.mimeType}`,
      );
    }

    const expectedClockRate =
      this.props.track.kind === "audio" ? 48_000 : 90_000;
    if (codec.clockRate !== expectedClockRate) {
      throw new Error(
        `Input ${this.props.track.kind} clock rate ${expectedClockRate} does not match negotiated clock rate ${codec.clockRate}`,
      );
    }

    assertCodecParameters({
      trackKind: this.props.track.kind === "audio" ? "audio" : "video",
      codec,
      sourceCodec: this.props.sourceCodec,
      decoderDescription: this.props.decoderDescription,
      sourceChannels: this.props.sourceChannels,
    });

    return codec;
  }
}

interface PlaybackTrack {
  inputTrack: InputTrack;
  track: MediaStreamTrack;
  sourceCodec: SupportedSourceCodec;
  decoderDescription?: ArrayBuffer | ArrayBufferView | null;
  sourceChannels?: number;
}

interface PlaybackSession {
  input: Input;
  mediaStartTimestamp: number;
  playbackTracks: PlaybackTrack[];
  runners: TrackPlaybackRunner[];
}

async function selectPlaybackTracks(
  input: Input,
  streamId: string,
  existingTracks: Partial<Record<"audio" | "video", MediaStreamTrack>> = {},
) {
  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  const primaryAudioTrack = primaryVideoTrack
    ? ((await primaryVideoTrack.getPrimaryPairableAudioTrack()) ??
      (await input.getPrimaryAudioTrack()))
    : await input.getPrimaryAudioTrack();

  const playbackTracks: PlaybackTrack[] = [];
  if (primaryAudioTrack) {
    playbackTracks.push(
      await createPlaybackTrack(
        primaryAudioTrack,
        streamId,
        existingTracks.audio,
      ),
    );
  }
  if (primaryVideoTrack) {
    playbackTracks.push(
      await createPlaybackTrack(
        primaryVideoTrack,
        streamId,
        existingTracks.video,
      ),
    );
  }

  if (!primaryVideoTrack && !primaryAudioTrack) {
    const fallbackAudioTrack = await input.getPrimaryAudioTrack();
    if (fallbackAudioTrack) {
      playbackTracks.push(
        await createPlaybackTrack(
          fallbackAudioTrack,
          streamId,
          existingTracks.audio,
        ),
      );
    }
  }

  return playbackTracks;
}

async function createPlaybackTrack(
  inputTrack: InputAudioTrack | InputVideoTrack,
  streamId: string,
  track?: MediaStreamTrack,
): Promise<PlaybackTrack> {
  const sourceCodec = await requireSupportedCodec(inputTrack);
  const decoderConfig = await inputTrack.getDecoderConfig();
  const kind = inputTrack.isAudioTrack() ? "audio" : "video";

  return {
    inputTrack,
    sourceCodec,
    decoderDescription:
      decoderConfig && "description" in decoderConfig
        ? (decoderConfig.description ?? null)
        : null,
    sourceChannels:
      decoderConfig && "numberOfChannels" in decoderConfig
        ? decoderConfig.numberOfChannels
        : undefined,
    track:
      track ??
      new MediaStreamTrack({
        kind,
        streamId,
        codec: defaultCodecForSource(sourceCodec),
      }),
  };
}

function defaultCodecForSource(sourceCodec: SupportedSourceCodec) {
  switch (sourceCodec) {
    case "avc":
      return useH264();
    case "vp8":
      return useVP8();
    case "vp9":
      return useVP9();
    case "av1":
      return useAV1X();
    case "opus":
      return useOPUS();
  }
}

async function requireSupportedCodec(inputTrack: InputTrack) {
  const codec = await inputTrack.getCodec();
  if (codec && supportedSourceCodecs.includes(codec as SupportedSourceCodec)) {
    return codec as SupportedSourceCodec;
  }

  const codecLabel =
    codec ??
    (await inputTrack.getCodecParameterString()) ??
    String((await inputTrack.getInternalCodecId()) ?? "unknown");

  throw new Error(
    `Unsupported ${inputTrack.type} codec "${codecLabel}". File playback supports H264, VP8, VP9, AV1, and Opus only.`,
  );
}

type ReplayableUserMediaSource =
  | { path: string; buffer?: never }
  | { path?: never; buffer: Buffer };

async function createReplayableSource(
  options: UserMediaSource,
): Promise<ReplayableUserMediaSource> {
  if (typeof options.path === "string") {
    return { path: options.path };
  }

  const buffer =
    options.buffer != undefined
      ? toBuffer(options.buffer)
      : await readStreamToBuffer(options.stream);

  return { buffer };
}

async function createInput(options: ReplayableUserMediaSource) {
  if (typeof options.path === "string") {
    const buffer = await readFile(resolveUserMediaPath(options.path));
    return new Input({
      source: new BufferSource(buffer),
      formats: [MP4, WEBM],
    });
  }

  return new Input({
    source: new BufferSource(options.buffer),
    formats: [MP4, WEBM],
  });
}

function resolveUserMediaPath(path: string) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(path);
}

async function readStreamToBuffer(
  stream: Readable | ReadableStream<Uint8Array>,
) {
  const chunks: Buffer[] = [];

  if (stream instanceof Readable) {
    for await (const chunk of stream) {
      chunks.push(toBuffer(chunk));
    }
    return Buffer.concat(chunks);
  }

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(
          Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        );
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

function toBuffer(value: Buffer | ArrayBuffer | ArrayBufferView | string) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(new Uint8Array(value));
}

function normalizeMimeType(mimeType: string) {
  return mimeType.toLowerCase();
}

function assertSupportedOptions(options: FileMediaTrackSource) {
  const legacyOptions = options as FileMediaTrackSource & {
    width?: unknown;
    height?: unknown;
  };

  if (legacyOptions.width != undefined || legacyOptions.height != undefined) {
    throw new Error(
      "File playback no longer accepts { width, height }. Resize or re-encode the source before creating the mp4/webm register.",
    );
  }
}

function createPlaybackSession({
  input,
  mediaStartTimestamp,
  playbackTracks,
}: {
  input: Input;
  mediaStartTimestamp: number;
  playbackTracks: PlaybackTrack[];
}): PlaybackSession {
  return {
    input,
    mediaStartTimestamp,
    playbackTracks,
    runners: playbackTracks.map(
      (playbackTrack) =>
        new TrackPlaybackRunner({
          mediaStartTimestamp,
          ...playbackTrack,
        }),
    ),
  };
}

function buildExistingTrackMap(
  audio?: MediaStreamTrack,
  video?: MediaStreamTrack,
): Partial<Record<"audio" | "video", MediaStreamTrack>> {
  return {
    ...(audio ? { audio } : {}),
    ...(video ? { video } : {}),
  };
}

function assertCodecParameters({
  trackKind,
  codec,
  sourceCodec,
  decoderDescription,
  sourceChannels,
}: {
  trackKind: "audio" | "video";
  codec: RTCRtpCodecParameters;
  sourceCodec: SupportedSourceCodec;
  decoderDescription?: ArrayBuffer | ArrayBufferView | null;
  sourceChannels?: number;
}) {
  if (sourceCodec === "opus" && sourceChannels && codec.channels != undefined) {
    if (codec.channels !== sourceChannels) {
      throw new Error(
        `Input ${trackKind} channels ${sourceChannels} do not match negotiated channels ${codec.channels}`,
      );
    }
    return;
  }

  if (sourceCodec !== "avc") {
    // mediabunny exposes codec-specific decoder configuration for H264 only here.
    return;
  }

  const negotiatedParameters = codecParametersFromString(
    codec.parameters ?? "",
  );
  const negotiatedPacketizationMode = Number(
    negotiatedParameters["packetization-mode"] ?? 1,
  );
  if (negotiatedPacketizationMode !== 1) {
    throw new Error(
      `Input ${trackKind} packetization-mode 1 does not match negotiated packetization-mode ${negotiatedPacketizationMode}`,
    );
  }

  const sourceProfileLevelId = getH264ProfileLevelId(decoderDescription);
  const negotiatedProfileLevelId = normalizeOptionalHexParameter(
    negotiatedParameters["profile-level-id"],
  );

  if (!sourceProfileLevelId) {
    return;
  }

  if (!negotiatedProfileLevelId) {
    throw new Error(
      `Input ${trackKind} profile-level-id ${sourceProfileLevelId} does not match negotiated profile-level-id <missing>`,
    );
  }

  if (sourceProfileLevelId !== negotiatedProfileLevelId) {
    throw new Error(
      `Input ${trackKind} profile-level-id ${sourceProfileLevelId} does not match negotiated profile-level-id ${negotiatedProfileLevelId}`,
    );
  }
}

function getH264ProfileLevelId(
  decoderDescription?: ArrayBuffer | ArrayBufferView | null,
) {
  if (!decoderDescription) {
    return undefined;
  }

  const description = toDescriptionBuffer(decoderDescription);
  if (description.length < 4) {
    throw new Error("invalid H264 decoder configuration");
  }

  return description.subarray(1, 4).toString("hex");
}

function normalizeOptionalHexParameter(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function toRtpTimestamp(
  packetTimestamp: number,
  mediaStartTimestamp: number,
  clockRate: number,
) {
  const relativeSeconds = Math.max(0, packetTimestamp - mediaStartTimestamp);
  return Math.round(relativeSeconds * clockRate) >>> 0;
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "The operation was aborted")
  );
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function toDescriptionBuffer(
  decoderDescription: ArrayBuffer | ArrayBufferView,
) {
  if (ArrayBuffer.isView(decoderDescription)) {
    return Buffer.from(
      decoderDescription.buffer,
      decoderDescription.byteOffset,
      decoderDescription.byteLength,
    );
  }

  return Buffer.from(decoderDescription);
}
