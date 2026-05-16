import { randomUUID } from "crypto";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { Readable } from "stream";
import { readFile } from "fs/promises";
import { setTimeout as wait } from "timers/promises";

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

import type { RTCRtpCodecParameters } from "../media/parameters";
import { MediaStreamTrack } from "../media/track";
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

export const getUserMedia = async (options: FileMediaTrackSource) => {
  const input = await createInput(options);
  try {
    if (!(await input.canRead())) {
      throw new Error("Only MP4 and WebM file playback is supported");
    }

    const playbackTracks = await selectPlaybackTracks(input);
    if (playbackTracks.length === 0) {
      throw new Error(
        "The media source does not contain playable audio or video tracks",
      );
    }

    const mediaStartTimestamp = await input.getFirstTimestamp(
      playbackTracks.map(({ inputTrack }) => inputTrack),
    );

    return new MediaPlayer({
      input,
      loop: options.loop ?? false,
      mediaStartTimestamp,
      playbackTracks,
    });
  } catch (error) {
    input.dispose();
    throw error;
  }
};

class MediaPlayer {
  readonly audio?: MediaStreamTrack;
  readonly video?: MediaStreamTrack;

  private readonly runners: TrackPlaybackRunner[];
  private readonly input: Input;
  private readonly loop: boolean;
  private readonly mediaStartTimestamp: number;
  private running?: Promise<void>;
  private abortController?: AbortController;
  private stopped = false;

  constructor({
    input,
    loop,
    mediaStartTimestamp,
    playbackTracks,
  }: {
    input: Input;
    loop: boolean;
    mediaStartTimestamp: number;
    playbackTracks: PlaybackTrack[];
  }) {
    this.input = input;
    this.loop = loop;
    this.mediaStartTimestamp = mediaStartTimestamp;
    this.runners = playbackTracks.map(
      (playbackTrack) =>
        new TrackPlaybackRunner({
          mediaStartTimestamp,
          ...playbackTrack,
        }),
    );

    this.audio = playbackTracks.find(
      ({ track }) => track.kind === "audio",
    )?.track;
    this.video = playbackTracks.find(
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

    this.runners.forEach((runner) => runner.assertReady());

    const abortController = new AbortController();
    this.abortController = abortController;

    this.running = this.run(abortController)
      .catch((error) => {
        if (!abortController.signal.aborted) {
          console.error("userMedia playback failed", error);
        }
      })
      .finally(() => {
        if (this.abortController === abortController) {
          this.abortController = undefined;
        }
        this.running = undefined;
        this.stopped = true;
        this.input.dispose();
      });
  }

  stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abortController?.abort();
    this.input.dispose();
  }

  private async run(abortController: AbortController) {
    let sourceChanged = false;

    do {
      const startedAt = performance.now();
      await Promise.all(
        this.runners.map((runner) =>
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
    this.requireNegotiatedCodec();
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

    return codec;
  }
}

interface PlaybackTrack {
  inputTrack: InputTrack;
  track: MediaStreamTrack;
  sourceCodec: SupportedSourceCodec;
  decoderDescription?: ArrayBuffer | ArrayBufferView | null;
}

async function selectPlaybackTracks(input: Input) {
  const streamId = randomUUID().toString();
  const primaryVideoTrack = await input.getPrimaryVideoTrack();
  const primaryAudioTrack = primaryVideoTrack
    ? ((await primaryVideoTrack.getPrimaryPairableAudioTrack()) ??
      (await input.getPrimaryAudioTrack()))
    : await input.getPrimaryAudioTrack();

  const playbackTracks: PlaybackTrack[] = [];
  if (primaryAudioTrack) {
    playbackTracks.push(await createPlaybackTrack(primaryAudioTrack, streamId));
  }
  if (primaryVideoTrack) {
    playbackTracks.push(await createPlaybackTrack(primaryVideoTrack, streamId));
  }

  if (!primaryVideoTrack && !primaryAudioTrack) {
    const fallbackAudioTrack = await input.getPrimaryAudioTrack();
    if (fallbackAudioTrack) {
      playbackTracks.push(
        await createPlaybackTrack(fallbackAudioTrack, streamId),
      );
    }
  }

  return playbackTracks;
}

async function createPlaybackTrack(
  inputTrack: InputAudioTrack | InputVideoTrack,
  streamId: string,
): Promise<PlaybackTrack> {
  const sourceCodec = await requireSupportedCodec(inputTrack);
  const decoderConfig = await inputTrack.getDecoderConfig();

  return {
    inputTrack,
    sourceCodec,
    decoderDescription:
      decoderConfig && "description" in decoderConfig
        ? (decoderConfig.description ?? null)
        : null,
    track: new MediaStreamTrack({
      kind: inputTrack.isAudioTrack() ? "audio" : "video",
      streamId,
    }),
  };
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

async function createInput(options: UserMediaSource) {
  if (typeof options.path === "string") {
    const buffer = await readFile(resolveUserMediaPath(options.path));
    return new Input({
      source: new BufferSource(buffer),
      formats: [MP4, WEBM],
    });
  }

  const buffer =
    options.buffer != undefined
      ? toBuffer(options.buffer)
      : await readStreamToBuffer(options.stream);

  return new Input({
    source: new BufferSource(buffer),
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
