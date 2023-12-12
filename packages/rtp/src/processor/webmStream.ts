import {
  ReadableStream,
  ReadableStreamController,
  WritableStream,
} from "stream/web";

import { SupportedCodec } from "../container/webm/container";
import { WebmBase, WebmInput, WebmOption, WebmOutput } from "./webm";

export type WebmStreamOutput = WebmOutput;

export type WebmStreamOption = WebmOption;

export class WebmStream extends WebmBase {
  audioStream!: WritableStream<WebmInput>;
  videoStream!: WritableStream<WebmInput>;
  webmStream: ReadableStream<WebmStreamOutput>;
  private controller!: ReadableStreamController<WebmStreamOutput>;

  constructor(
    tracks: {
      width?: number;
      height?: number;
      kind: "audio" | "video";
      codec: SupportedCodec;
      clockRate: number;
      trackNumber: number;
    }[],
    options: WebmStreamOption = {},
  ) {
    super(
      tracks,
      (output) => {
        this.controller.enqueue(output);
      },
      options,
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

    this.webmStream = new ReadableStream<WebmStreamOutput>({
      start: (controller) => {
        this.controller = controller;
      },
    });

    this.start();
  }
}
