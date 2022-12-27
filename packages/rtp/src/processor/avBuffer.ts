import { int } from "../../../common/src";
import { DepacketizerOutput } from "./depacketizer";
import { Max32Uint } from "./webm";

export type AVBufferInput = DepacketizerOutput;

export type AVBufferOutput = AVBufferInput;

/**
 * @description [japanese]
 * audioパケットとvideoパケットを同一のタイムラインで扱い、それぞれの
 * パケットのタイムスタンプが前後しないように制御する
 */
export class AVBufferBase {
  bufferLength = this.options.bufferLength ?? 50;
  baseAudioTimestamp?: number;
  baseVideoTimestamp?: number;
  audioBuffer: (AVBufferInput & { elapsed: number; kind: string })[][] = [
    ...new Array(this.bufferLength),
  ].map(() => []);
  videoBuffer: (AVBufferInput & { elapsed: number; kind: string })[][] = [
    ...new Array(this.bufferLength),
  ].map(() => []);
  stopped = false;
  private interval = this.options.interval ?? 500;
  private started = false;

  constructor(
    private audioOutput: (output: AVBufferOutput) => void,
    private videoOutput: (output: AVBufferOutput) => void,
    private options: Partial<AvBufferOptions> = {}
  ) {}

  private start() {
    if ([...this.audioBuffer[1], ...this.videoBuffer[1]].length === 0) {
      return;
    }

    if (this.started) {
      return;
    }
    this.started = true;

    let index = 0;
    setInterval(() => {
      const joined = [...this.audioBuffer[index], ...this.videoBuffer[index]];
      const sorted = joined.sort((a, b) => a.elapsed - b.elapsed);
      this.audioBuffer[index] = [];
      this.videoBuffer[index] = [];

      for (const output of sorted) {
        if (output.kind === "audio") {
          this.audioOutput(output);
        } else {
          this.videoOutput(output);
        }
      }

      index++;
      if (index === this.bufferLength) {
        index = 0;
      }
    }, this.interval);
  }

  processAudioInput = (input: AVBufferInput) => {
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

    const { elapsed, rotate } = this.calcElapsed(
      this.baseAudioTimestamp,
      input.frame.timestamp,
      48000
    );
    if (rotate) {
      this.baseAudioTimestamp = input.frame?.timestamp;
    }

    const index = int(elapsed / this.interval) % this.bufferLength;
    this.audioBuffer[index].push({ ...input, elapsed, kind: "audio" });

    this.start();
  };

  processVideoInput = (input: AVBufferInput) => {
    if (!input.frame) {
      this.stopped = true;
      this.videoOutput(input);
      return;
    }
    if (this.stopped) {
      return;
    }

    if (this.baseVideoTimestamp == undefined) {
      this.baseVideoTimestamp = input.frame?.timestamp;
    }

    const { elapsed, rotate } = this.calcElapsed(
      this.baseVideoTimestamp,
      input.frame.timestamp,
      90000
    );
    if (rotate) {
      this.baseVideoTimestamp = input.frame?.timestamp;
    }

    const index = int(elapsed / this.interval) % this.bufferLength;
    this.videoBuffer[index].push({ ...input, elapsed, kind: "video" });

    this.start();
  };

  private calcElapsed(base: number, timestamp: number, clockRate: number) {
    const rotate = Math.abs(timestamp - base) > (Max32Uint / 4) * 3;
    if (rotate) {
      console.log(rotate);
    }

    const diff = rotate ? timestamp + Max32Uint - base : timestamp - base;
    /**ms */
    const elapsed = int((diff / clockRate) * 1000);
    return { elapsed, rotate };
  }
}

export interface AvBufferOptions {
  interval: number;
  bufferLength: number;
}
