import { Event } from "../../imports/common";

import { OpusRtpPayload } from "../..";
import {
  annexb2avcSample,
  type DataType,
  Mp4Container,
  type Mp4SupportedCodec,
  annexb2avcc,
} from "../container/mp4";
import type { AVProcessor } from "./interface";

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
    private output: (output: Mp4Output) => void,
    private options: MP4Option = {},
  ) {
    this.container = new Mp4Container({
      track: {
        audio: !!this.tracks.find((t) => t.kind === "audio"),
        video: !!this.tracks.find((t) => t.kind === "video"),
      },
    });
    this.container.onData.subscribe((data) => {
      this.output(data);
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
        if (!this.tracks.some((track) => track.kind === "audio") || this.audioStopped) {
          void this.stop();
        }
      }
      return;
    }

    const track = this.tracks.find((t) => t.kind === "video")!;

    this.videoStopped = false;
    if (!this.container.videoTrack) {
      if (frame.isKeyframe) {
        const avcc = annexb2avcc(frame.data);
        const sample = annexb2avcSample(frame.data);

        const [displayAspectWidth, displayAspectHeight] = computeRatio(
          track.width!,
          track.height!,
        );

        this.container.write({
          codec: avccToCodecString(avcc),
          codedWidth: track.width,
          codedHeight: track.height,
          description: toArrayBuffer(Buffer.from(avcc)),
          displayAspectWidth,
          displayAspectHeight,
          track: "video",
        });
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
        if (!this.tracks.some((track) => track.kind === "video") || this.videoStopped) {
          void this.stop();
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
    await this.container.stop();
    this.output({ eol: true });
    this.onStopped.execute();
  }
}

function computeRatio(a: number, b: number) {
  function gcd(x: number, y: number) {
    while (y !== 0) {
      const temp = y;
      y = x % y;
      x = temp;
    }
    return x;
  }

  const divisor = gcd(a, b);
  return [a / divisor, b / divisor];
}

export interface Track {
  width?: number;
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
