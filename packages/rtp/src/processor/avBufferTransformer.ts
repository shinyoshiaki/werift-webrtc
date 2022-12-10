import {
  ReadableStream,
  ReadableStreamController,
  WritableStream,
} from "stream/web";

import { AVBufferBase, AVBufferInput, AVBufferOutput } from "./avBuffer";

export class AVBufferTransformer extends AVBufferBase {
  audioStream!: WritableStream<AVBufferInput>;
  videoStream!: WritableStream<AVBufferInput>;
  outputAudioStream: ReadableStream<AVBufferOutput>;
  outputVideoStream: ReadableStream<AVBufferOutput>;
  private audioController!: ReadableStreamController<AVBufferOutput>;
  private videoController!: ReadableStreamController<AVBufferOutput>;

  constructor() {
    super(
      (output) => this.audioController.enqueue(output),
      (output) => this.videoController.enqueue(output)
    );

    this.audioStream = new WritableStream({
      write: (input) => {
        this.processAudioInput(input);
      },
    });
    this.videoStream = new WritableStream({
      write: (input) => {
        this.processVideoInput(input);
      },
    });

    this.outputAudioStream = new ReadableStream<AVBufferOutput>({
      start: (controller) => {
        this.audioController = controller;
      },
    });
    this.outputVideoStream = new ReadableStream<AVBufferOutput>({
      start: (controller) => {
        this.videoController = controller;
      },
    });
  }
}
