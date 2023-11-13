import Event from "rx.mini";

import {
  annexb2avcc,
  buffer2ArrayBuffer,
  Mp4Container,
  Mp4SupportedCodec,
  OpusRtpPayload,
} from "..";
import { AVProcessor } from "./interface";

export type Mp4Input = {
  frame?: {
    data: Buffer;
    isKeyframe: boolean;
    /**ms */
    time: number;
  };
  eol?: boolean;
};

export interface Mp4Output {
  type: string;
  timestamp: number;
  duration: number;
  data: Uint8Array;
  eol?: boolean;
}

export interface MP4Option {
  /**ms */
  duration?: number;
  encryptionKey?: Buffer;
  strictTimestamp?: boolean;
}

export class MP4Base implements AVProcessor<Mp4Input> {
  private internalStats = {};
  private container = new Mp4Container({
    track: {
      audio: !!this.tracks.find((t) => t.kind === "audio"),
      video: !!this.tracks.find((t) => t.kind === "video"),
    },
  });
  stopped = false;
  onStopped = new Event();

  constructor(
    public tracks: Track[],
    private output: (output: Mp4Output) => void,
    private options: MP4Option = {}
  ) {
    this.container.onData.subscribe((data) => {
      this.output(data);
    });
  }

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
    };
  }

  processAudioInput = ({ frame }: Mp4Input) => {
    const track = this.tracks.find((t) => t.kind === "audio")!;

    if (frame) {
      if (!this.container.audioTrack) {
        this.container.write({
          codec: track.codec,
          description: buffer2ArrayBuffer(OpusRtpPayload.createCodecPrivate()),
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
          copyTo: (destination: Uint8Array) => {
            frame.data.copy(destination);
          },
          track: "audio",
        });
      }
    }
  };

  processVideoInput = ({ frame }: Mp4Input) => {
    const track = this.tracks.find((t) => t.kind === "video")!;

    if (frame) {
      if (!this.container.videoTrack) {
        if (frame.isKeyframe) {
          const avcc = annexb2avcc(frame.data);

          const [displayAspectWidth, displayAspectHeight] = computeRatio(
            track.width!,
            track.height!
          );

          this.container.write({
            codec: track.codec,
            codedWidth: track.width,
            codedHeight: track.height,
            description: avcc.buffer,
            displayAspectWidth,
            displayAspectHeight,
            track: "video",
          });
          this.container.write({
            byteLength: frame.data.length,
            duration: null,
            timestamp: frame.time * 1000,
            type: "key",
            copyTo: (destination: Uint8Array) => {
              frame.data.copy(destination);
            },
            track: "video",
          });
        }
      } else {
        this.container.write({
          byteLength: frame.data.length,
          duration: null,
          timestamp: frame.time * 1000,
          type: frame.isKeyframe ? "key" : "delta",
          copyTo: (destination: Uint8Array) => {
            frame.data.copy(destination);
          },
          track: "video",
        });
      }
    }
  };

  protected start() {}

  stop() {}
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
