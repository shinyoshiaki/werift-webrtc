import { Event } from "../../../imports/common";
import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  NullTarget,
  Output,
} from "mediabunny";

type DecoderConfig = AudioDecoderConfig | VideoDecoderConfig;
type EncodedChunk = EncodedAudioChunk | EncodedVideoChunk;
type TrackKind = "audio" | "video";

interface AudioChunkMetadata {
  decoderConfig: {
    codec: "opus";
    description?: Uint8Array;
    numberOfChannels: number;
    sampleRate: number;
  };
}

interface VideoChunkMetadata {
  decoderConfig: {
    codec: string;
    codedHeight: number;
    codedWidth: number;
    description?: Uint8Array;
    displayAspectHeight?: number;
    displayAspectWidth?: number;
  };
}

interface FragmentMeta {
  duration: number;
  kind: TrackKind;
  timestamp: number;
  type: DataType;
}

export type DataType = "init" | "delta" | "key";

export interface Mp4Data {
  type: DataType;
  timestamp: number;
  duration: number;
  data: Uint8Array;
  kind: "audio" | "video";
}

export class Mp4Container {
  #audioFrame?: (EncodedChunk & { track: TrackKind }) | undefined;
  #audioMeta?: AudioChunkMetadata;
  #audioSource?: EncodedAudioPacketSource;
  #currentFragment?: FragmentMeta;
  #ftyp?: Uint8Array;
  #initializationEmitted = false;
  #lastAudioDuration = 0;
  #lastMoof?: Uint8Array;
  #lastMoofTimestamp = 0;
  #lastVideoDuration = 0;
  #moov?: Uint8Array;
  #operation = Promise.resolve();
  #output?:
    | Output<Mp4OutputFormat, NullTarget>
    | undefined;
  #startPromise?: Promise<void>;
  #stopPromise?: Promise<void>;
  #stopped = false;
  #videoFrame?: (EncodedChunk & { track: TrackKind }) | undefined;
  #videoMeta?: VideoChunkMetadata;
  #videoSource?: EncodedVideoPacketSource;
  audioTrack?: number;
  frameBuffer: (EncodedChunk & {
    track: TrackKind;
  })[] = [];
  onData = new Event<[Mp4Data | { eol: true }]>();
  videoTrack?: number;

  constructor(
    private props: {
      track: { audio: boolean; video: boolean };
    },
  ) {}

  get tracksReady() {
    let ready = true;
    if (this.props.track.audio && !this.audioTrack) {
      ready = false;
    }
    if (this.props.track.video && !this.videoTrack) {
      ready = false;
    }
    return ready;
  }

  write(
    frame: (DecoderConfig | EncodedChunk) & {
      track: TrackKind;
    },
  ) {
    if (isDecoderConfig(frame)) {
      return this.#init(frame);
    } else {
      return this.#enqueue(frame);
    }
  }

  #init(
    frame: DecoderConfig & {
      track: TrackKind;
    },
  ) {
    if (frame.track === "audio") {
      if (isVideoConfig(frame)) {
        throw new Error("audio track requires an audio decoder config");
      }
      if (frame.codec !== "opus") {
        throw new Error(`unsupported codec: ${frame.codec}`);
      }
      this.#audioMeta = {
        decoderConfig: {
          codec: "opus",
          description:
            frame.description != undefined
              ? new Uint8Array(frame.description)
              : undefined,
          numberOfChannels: frame.numberOfChannels,
          sampleRate: frame.sampleRate,
        },
      };
      this.audioTrack = 1;
    } else {
      if (!isVideoConfig(frame)) {
        throw new Error("video track requires a video decoder config");
      }
      if (!frame.codec.startsWith("avc1")) {
        throw new Error(`unsupported codec: ${frame.codec}`);
      }
      if (frame.codedWidth == undefined || frame.codedHeight == undefined) {
        throw new Error("missing coded video dimensions");
      }
      this.#videoMeta = {
        decoderConfig: {
          codec: frame.codec,
          codedHeight: frame.codedHeight,
          codedWidth: frame.codedWidth,
          description:
            frame.description != undefined
              ? new Uint8Array(frame.description)
              : undefined,
          displayAspectHeight: frame.displayAspectHeight,
          displayAspectWidth: frame.displayAspectWidth,
        },
      };
      this.videoTrack = this.props.track.audio ? 2 : 1;
    }

    if (!this.tracksReady) {
      return;
    }

    void this.#enqueueOperation(async () => {
      await this.#ensureOutputStarted();
      await this.#drainFrameBuffer();
    });
  }

  #enqueue(
    frame: EncodedChunk & {
      track: TrackKind;
    },
  ) {
    this.frameBuffer.push(frame);
    if (!this.tracksReady) {
      return;
    }
    void this.#enqueueOperation(async () => {
      await this.#ensureOutputStarted();
      await this.#drainFrameBuffer();
    });
  }

  stop() {
    if (this.#stopPromise) {
      return this.#stopPromise;
    }

    this.#stopped = true;
    this.#stopPromise = this.#enqueueOperation(async () => {
      if (!this.tracksReady) {
        this.frameBuffer = [];
        return;
      }

      await this.#ensureOutputStarted();
      await this.#drainFrameBuffer();
      await this.#flushPendingFrame("audio");
      await this.#flushPendingFrame("video");

      this.#audioSource?.close();
      this.#videoSource?.close();
      if (this.#output) {
        await this.#output.finalize();
      }

      this.onData.execute({ eol: true });
    });
    return this.#stopPromise;
  }

  async #drainFrameBuffer() {
    const frames = this.frameBuffer;
    this.frameBuffer = [];

    for (const frame of frames) {
      await this.#processFrame(frame);
    }
  }

  async #ensureOutputStarted() {
    if (this.#startPromise) {
      await this.#startPromise;
      return;
    }
    if (!this.tracksReady) {
      return;
    }

    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: "fragmented",
        minimumFragmentDuration: 0,
        onFtyp: (data) => {
          this.#ftyp = copyBytes(data);
        },
        onMdat: (data) => {
          if (!this.#lastMoof) {
            throw new Error("moof missing before mdat");
          }

          const fragment = this.#currentFragment;
          const timestamp = fragment
            ? fragment.timestamp
            : Math.round(this.#lastMoofTimestamp * 1_000_000);
          const duration = fragment?.duration ?? 0;
          const kind = fragment?.kind ?? this.#defaultKind();
          const type = fragment?.type ?? "key";
          const segment = concatBytes(this.#lastMoof, data);

          this.#currentFragment = undefined;
          this.#lastMoof = undefined;

          this.onData.execute({
            type,
            timestamp,
            duration,
            data: segment,
            kind,
          });
        },
        onMoof: (data, _position, timestamp) => {
          this.#lastMoof = copyBytes(data);
          this.#lastMoofTimestamp = timestamp;
        },
        onMoov: (data) => {
          this.#moov = copyBytes(data);
          this.#emitInitializationSegment();
        },
      }),
      target: new NullTarget(),
    });

    if (this.#audioMeta) {
      this.#audioSource = new EncodedAudioPacketSource("opus");
      output.addAudioTrack(this.#audioSource);
    }
    if (this.#videoMeta) {
      this.#videoSource = new EncodedVideoPacketSource("avc");
      output.addVideoTrack(this.#videoSource);
    }

    this.#output = output;
    this.#startPromise = output.start();
    await this.#startPromise;
  }

  #emitInitializationSegment() {
    if (this.#initializationEmitted || !this.#ftyp || !this.#moov) {
      return;
    }

    this.#initializationEmitted = true;
    this.onData.execute({
      type: "init",
      timestamp: 0,
      duration: 0,
      data: concatBytes(this.#ftyp, this.#moov),
      kind: this.#defaultKind(),
    });
  }

  #enqueueOperation(operation: () => Promise<void>) {
    const next = this.#operation.then(operation);
    this.#operation = next;
    return next;
  }

  #defaultKind(): TrackKind {
    return this.props.track.video ? "video" : "audio";
  }

  async #flushPendingFrame(track: TrackKind) {
    const buffered = track === "audio" ? this.#audioFrame : this.#videoFrame;
    if (!buffered) {
      return;
    }

    const duration = track === "audio" ? this.#lastAudioDuration : this.#lastVideoDuration;
    await this.#writePacket(buffered, duration);

    if (track === "audio") {
      this.#audioFrame = undefined;
    } else {
      this.#videoFrame = undefined;
    }
  }

  async #processFrame(
    frame: EncodedChunk & {
      track: TrackKind;
    },
  ) {
    const buffered = frame.track === "audio" ? this.#audioFrame : this.#videoFrame;
    if (!buffered) {
      if (frame.track === "audio") {
        this.#audioFrame = frame;
      } else {
        this.#videoFrame = frame;
      }
      return;
    }

    const duration = Math.max(frame.timestamp - buffered.timestamp, 0);
    await this.#writePacket(buffered, duration);

    if (frame.track === "audio") {
      this.#audioFrame = frame;
      this.#lastAudioDuration = duration;
    } else {
      this.#videoFrame = frame;
      this.#lastVideoDuration = duration;
    }
  }

  async #writePacket(
    frame: EncodedChunk & {
      track: TrackKind;
    },
    duration: number,
  ) {
    const data = new Uint8Array(frame.byteLength);
    frame.copyTo(data.buffer);

    const packet = new EncodedPacket(
      data,
      frame.type,
      frame.timestamp / 1_000_000,
      duration / 1_000_000,
    );

    if (frame.track === "audio") {
      if (!this.#audioSource || !this.#audioMeta) {
        throw new Error("audio track missing");
      }

      await this.#audioSource.add(packet, this.#audioMeta);
    } else {
      if (!this.#videoSource || !this.#videoMeta) {
        throw new Error("video track missing");
      }

      await this.#videoSource.add(packet, this.#videoMeta);
    }

    this.#rememberFragmentPacket(frame.track, frame.type, frame.timestamp, duration);
  }

  #rememberFragmentPacket(
    kind: TrackKind,
    type: EncodedChunk["type"],
    timestamp: number,
    duration: number,
  ) {
    const end = timestamp + duration;
    if (!this.#currentFragment) {
      this.#currentFragment = {
        kind,
        type,
        timestamp,
        duration,
      };
      return;
    }

    if (kind === "video" && type === "key") {
      this.#currentFragment.type = "key";
    }

    const fragmentEnd = Math.max(
      this.#currentFragment.timestamp + this.#currentFragment.duration,
      end,
    );
    this.#currentFragment.duration = fragmentEnd - this.#currentFragment.timestamp;
  }
}

function isDecoderConfig(
  frame: DecoderConfig | EncodedChunk,
): frame is DecoderConfig {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return (frame as DecoderConfig).codec !== undefined;
}

function isVideoConfig(frame: DecoderConfig): frame is VideoDecoderConfig {
  return (frame as VideoDecoderConfig).codedWidth !== undefined;
}

export interface AudioDecoderConfig {
  codec: string;
  description?: ArrayBuffer | undefined;
  numberOfChannels: number;
  sampleRate: number;
}

export interface VideoDecoderConfig {
  codec: string;
  codedHeight?: number | undefined;
  codedWidth?: number | undefined;
  description?: ArrayBuffer | undefined;
  displayAspectHeight?: number | undefined;
  displayAspectWidth?: number | undefined;
  optimizeForLatency?: boolean | undefined;
}

interface EncodedAudioChunk {
  readonly byteLength: number;
  readonly duration: number | null;
  readonly timestamp: number;
  readonly type: EncodedAudioChunkType;
  copyTo(destination: ArrayBuffer): void;
}

type EncodedAudioChunkType = "delta" | "key";

interface EncodedVideoChunk {
  readonly byteLength: number;
  readonly duration: number | null;
  readonly timestamp: number;
  readonly type: EncodedVideoChunkType;
  copyTo(destination: ArrayBuffer): void;
}

type EncodedVideoChunkType = "delta" | "key";

export const mp4SupportedCodecs = ["avc1", "opus"] as const;
export type Mp4SupportedCodec = (typeof mp4SupportedCodecs)[number];

function concatBytes(...parts: Uint8Array[]) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(size);
  let offset = 0;

  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }

  return combined;
}

function copyBytes(data: Uint8Array) {
  return new Uint8Array(data);
}
