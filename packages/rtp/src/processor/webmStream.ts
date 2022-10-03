import {
  ReadableStream,
  ReadableStreamController,
  WritableStream,
} from "stream/web";

import { SupportedCodec } from "../container/webm";
import { WebmBase, WebmInput } from "./webm";

export type WebmLiveOutput = {
  saveToFile?: Buffer;
  eol?: {
    /**ms */
    duration: number;
    durationElement: Uint8Array;
  };
};

export interface WebmLiveOption {
  /**ms */
  duration?: number;
}

export class WebmStream extends WebmBase {
  audioStream!: WritableStream<WebmInput>;
  videoStream!: WritableStream<WebmInput>;
  webmStream: ReadableStream<WebmLiveOutput>;
  private controller!: ReadableStreamController<WebmLiveOutput>;

  constructor(
    tracks: {
      width?: number;
      height?: number;
      kind: "audio" | "video";
      codec: SupportedCodec;
      clockRate: number;
      trackNumber: number;
    }[],
    options: WebmLiveOption = {}
  ) {
    super(
      tracks,
      (output) => {
        this.controller.enqueue(output);
      },
      options
    );

    const audioTrack = tracks.find((t) => t.kind === "audio");
    if (audioTrack) {
      this.audioStream = new WritableStream({
        write: (input) => {
          this.processAudioInput(input);
        },
      });
    }

    const videoTrack = tracks.find((t) => t.kind === "video");
    if (videoTrack) {
      this.videoStream = new WritableStream({
        write: (input) => {
          this.processVideoInput(input);
        },
      });
    }

    this.webmStream = new ReadableStream<WebmLiveOutput>({
      start: (controller) => {
        this.controller = controller;
      },
    });

    this.start();
  }
}
