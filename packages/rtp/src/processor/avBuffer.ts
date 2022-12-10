import { int } from "../../../common/src";
import { DepacketizerOutput } from "./depacketizer";
import { Max32Uint } from "./webm";

export type AVBufferInput = DepacketizerOutput;

export type AVBufferOutput = AVBufferInput;

export class AVBufferBase {
  baseAudioTimestamp?: number;
  baseVideoTimestamp?: number;
  audioBuffer: AVBufferInput[] = [];
  stopped = false;

  constructor(
    private audioOutput: (output: AVBufferOutput) => void,
    private videoOutput: (output: AVBufferOutput) => void
  ) {}

  processAudioInput(input: AVBufferInput) {
    if (!input.frame) {
      this.stopped = true;
      this.audioOutput(input);
      return;
    }
    if (this.stopped) {
      return;
    }

    if (this.baseAudioTimestamp == undefined) {
      this.baseAudioTimestamp = input.frame?.timestamp;
    }
    this.audioBuffer.push(input);
    const { elapsed, rotate } = this.calcElapsed(
      this.baseAudioTimestamp,
      input.frame.timestamp,
      48000
    );
    console.log("audio", elapsed, this.audioBuffer.length);
  }

  async processVideoInput(input: AVBufferInput) {
    if (!input.frame) {
      this.stopped = true;
      this.videoOutput(input);
      return;
    }
    if (this.stopped) {
      return;
    }

    await new Promise((r) => setTimeout(r, (90000 - 48000) / 10000));

    const { timestamp } = input.frame;

    if (this.baseVideoTimestamp == undefined) {
      this.baseVideoTimestamp = timestamp;
    }

    const { elapsed: videoElapsed, rotate } = this.calcElapsed(
      this.baseVideoTimestamp,
      timestamp,
      90000
    );
    if (rotate) {
      this.baseVideoTimestamp = input.frame.timestamp;
    }

    const index = this.audioBuffer.findIndex((a) => {
      const { timestamp } = a.frame!;
      const { elapsed, rotate } = this.calcElapsed(
        this.baseAudioTimestamp!,
        timestamp,
        48000
      );
      const target = elapsed > videoElapsed;
      if (target && rotate) {
        this.baseAudioTimestamp = timestamp;
      }
      if (target) {
        console.log("over", elapsed, videoElapsed);
      }
      return target;
    });
    const buffer = this.audioBuffer.splice(0, index);
    buffer.forEach((b) => this.audioOutput(b));
    this.videoOutput(input);
  }

  private calcElapsed(base: number, timestamp: number, clockRate: number) {
    const rotate = Math.abs(timestamp - base) > (Max32Uint / 4) * 3;
    if (rotate) {
      console.log(rotate);
    }

    const diff = rotate ? timestamp + Max32Uint - base : timestamp - base;
    const elapsed = int((diff / clockRate) * 1000);
    return { elapsed, rotate };
  }
}
