import { Event, debug } from "../../imports/common";

import { OpusRtpPayload } from "../..";
import {
  type DataType,
  Mp4Container,
  type Mp4SupportedCodec,
  annexb2avcSample,
  parseAvcDecoderConfig,
} from "../container/mp4";
import type { AVProcessor } from "./interface";

const log = debug("werift-rtp : packages/rtp/src/extra/processor/mp4.ts");

export type Mp4Input = {
  frame?: {
    data: Buffer;
    isKeyframe: boolean;
    /**ms */
    time: number;
  };
  eol?: boolean;
};

export type Mp4Output =
  | {
      type: DataType;
      timestamp: number;
      duration: number;
      data: Uint8Array;
      eol?: false | undefined;
      kind: "audio" | "video";
    }
  | {
      eol: true;
    };

export interface MP4Option {
  /**ms */
  duration?: number;
  encryptionKey?: Buffer;
  strictTimestamp?: boolean;
}

export class MP4Base implements AVProcessor<Mp4Input> {
  audioStopped = false;
  private internalStats = {};
  private container: Mp4Container;
  stopped = false;
  onStopped = new Event();
  videoStopped = false;

  constructor(
    public tracks: Track[],
    private output: (output: Mp4Output) => void | Promise<void>,
    private options: MP4Option = {},
  ) {
    this.container = new Mp4Container({
      track: {
        audio: !!this.tracks.find((t) => t.kind === "audio"),
        video: !!this.tracks.find((t) => t.kind === "video"),
      },
    });
    this.container.onData.subscribe(async (data) => {
      await this.output(data);
    });
  }

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
    };
  }

  processVideoInput = ({ eol, frame }: Mp4Input) => {
    if (this.stopped) {
      return;
    }

    if (!frame) {
      if (eol) {
        this.videoStopped = true;
        if (
          !this.tracks.some((track) => track.kind === "audio") ||
          this.audioStopped
        ) {
          void this.stop().catch(() => undefined);
        }
      }
      return;
    }

    const track = this.tracks.find((t) => t.kind === "video")!;

    this.videoStopped = false;
    if (!this.container.videoTrack) {
      if (frame.isKeyframe) {
        const config = resolveVideoDecoderConfig(track, frame.data);
        if (!config) {
          // Keep the video track uninitialized and wait for the next keyframe,
          // the same way delta frames before the first keyframe are dropped.
          log(
            "skip keyframe: avcC / dimensions could not be resolved from SPS/PPS",
            { time: frame.time },
          );
          return;
        }
        const sample = annexb2avcSample(frame.data);

        this.container.write(config);
        this.container.write({
          byteLength: sample.length,
          duration: null,
          timestamp: frame.time * 1000,
          type: "key",
          copyTo: (destination) => {
            new Uint8Array(destination).set(sample);
          },
          track: "video",
        });
      }
    } else {
      const sample = annexb2avcSample(frame.data);
      this.container.write({
        byteLength: sample.length,
        duration: null,
        timestamp: frame.time * 1000,
        type: frame.isKeyframe ? "key" : "delta",
        copyTo: (destination) => {
          new Uint8Array(destination).set(sample);
        },
        track: "video",
      });
    }
  };

  processAudioInput = ({ eol, frame }: Mp4Input) => {
    if (this.stopped) {
      return;
    }

    if (!frame) {
      if (eol) {
        this.audioStopped = true;
        if (
          !this.tracks.some((track) => track.kind === "video") ||
          this.videoStopped
        ) {
          void this.stop().catch(() => undefined);
        }
      }
      return;
    }

    const track = this.tracks.find((t) => t.kind === "audio")!;

    this.audioStopped = false;
    if (!this.container.audioTrack) {
      this.container.write({
        codec: track.codec,
        description: toArrayBuffer(OpusRtpPayload.createCodecPrivate()),
        numberOfChannels: 2,
        sampleRate: track.clockRate,
        track: "audio",
      });
    } else {
      this.container.write({
        byteLength: frame.data.length,
        duration: null,
        timestamp: frame.time * 1000,
        type: "key",
        copyTo: (destination) => {
          new Uint8Array(destination).set(frame.data);
        },
        track: "audio",
      });
    }
  };

  protected start() {}

  async stop() {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    try {
      await this.container.stop();
    } catch {
      // Timestamp / muxer errors must not leak as unhandled rejections.
    }
    await this.output({ eol: true });
    await this.onStopped.execute();
  }
}

function resolveVideoDecoderConfig(track: Track, data: Buffer) {
  const avcConfig = parseAvcDecoderConfig(data);
  if (!avcConfig) {
    return undefined;
  }

  // Explicit track dimensions take precedence over the SPS.
  const explicit =
    isPositiveInteger(track.width) && isPositiveInteger(track.height)
      ? { width: track.width, height: track.height }
      : undefined;
  const codedSize = explicit ?? avcConfig.codedSize;
  // Display aspect = coded size x SAR, kept as exact integers so that e.g.
  // 320x240 @ SAR 4:3 becomes 16:9 instead of a rounded 427:240.
  const { sampleAspectRatio: sar } = avcConfig;
  const ratio = explicit
    ? computeRatio(explicit.width, explicit.height)
    : computeRatio(codedSize.width * sar.width, codedSize.height * sar.height);

  return {
    codec: avccToCodecString(avcConfig.avcc),
    codedWidth: codedSize.width,
    codedHeight: codedSize.height,
    description: toArrayBuffer(Buffer.from(avcConfig.avcc)),
    displayAspectWidth: ratio?.[0],
    displayAspectHeight: ratio?.[1],
    track: "video" as const,
  };
}

/**
 * Reduces `a:b` to its lowest terms.
 * Returns `undefined` unless both values are positive finite integers.
 * @internal
 */
export function computeRatio(
  a: number | undefined,
  b: number | undefined,
): [number, number] | undefined {
  if (!isPositiveInteger(a) || !isPositiveInteger(b)) {
    return undefined;
  }

  let x = a;
  let y = b;
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return [a / x, b / x];
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export interface Track {
  /**
   * Video width in pixels.
   * When `width` / `height` are not both positive integers, the coded size from
   * the SPS of the first usable keyframe is used instead.
   */
  width?: number;
  /**
   * Video height in pixels.
   * When `width` / `height` are not both positive integers, the coded size from
   * the SPS of the first usable keyframe is used instead.
   */
  height?: number;
  kind: "audio" | "video";
  codec: Mp4SupportedCodec;
  clockRate: number;
  trackNumber: number;
}

function avccToCodecString(avcc: Uint8Array) {
  if (avcc.byteLength < 4) {
    throw new Error("invalid avcc decoder configuration record");
  }

  return `avc1.${toHex(avcc[1])}${toHex(avcc[2])}${toHex(avcc[3])}`;
}

function toHex(value: number) {
  return value.toString(16).padStart(2, "0");
}

function toArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}
