import { int } from "../../../common/src";
import { CodecFrame } from "./depacketizer";
import { AVProcessor } from "./interface";

export type LipsyncInput = {
  frame?: CodecFrame;
  eol?: boolean;
};

export type LipsyncOutput = {
  frame?: CodecFrame;
  eol?: boolean;
};

export class LipsyncBase implements AVProcessor<LipsyncInput> {
  bufferLength: number;
  /**ms */
  baseTime?: number;
  audioBuffer: (LipsyncInput & {
    elapsed: number;
    kind: string;
    [key: string]: any;
  })[][];
  videoBuffer: (LipsyncInput & {
    elapsed: number;
    kind: string;
    [key: string]: any;
  })[][];
  stopped = false;
  /**ms */
  private interval: number;
  private started = false;
  /**ms */
  lastCommited = 0;

  constructor(
    private audioOutput: (output: LipsyncOutput) => void,
    private videoOutput: (output: LipsyncOutput) => void,
    private options: Partial<LipSyncOptions> = {}
  ) {
    this.bufferLength = this.options.bufferLength ?? 50;
    this.audioBuffer = [...new Array(this.bufferLength)].map(() => []);
    this.videoBuffer = [...new Array(this.bufferLength)].map(() => []);
    this.interval = this.options.interval ?? 500;
  }

  private start() {
    // 2列目にカーソルが移ってから処理を始めることで1列目の処理を完了できる
    if ([...this.audioBuffer[1], ...this.videoBuffer[1]].length === 0) {
      return;
    }

    if (this.started) {
      return;
    }
    this.started = true;

    let index = 0;
    setInterval(() => {
      const joined = [
        ...this.audioBuffer[index],
        ...this.videoBuffer[index],
      ].filter((b) => b.elapsed >= this.lastCommited);
      const sorted = joined.sort((a, b) => a.frame!.time - b.frame!.time);
      this.audioBuffer[index] = [];
      this.videoBuffer[index] = [];

      for (const output of sorted) {
        if (output.kind === "audio") {
          this.audioOutput(output);
        } else {
          this.videoOutput(output);
        }
        this.lastCommited = output.elapsed;
      }

      index++;
      if (index === this.bufferLength) {
        index = 0;
      }
    }, this.interval);
  }

  processAudioInput = ({ frame, eol }: LipsyncInput) => {
    if (!frame) {
      this.stopped = true;
      this.audioOutput({ eol });
      return;
    }
    if (this.stopped) {
      return;
    }

    if (this.baseTime == undefined) {
      this.baseTime = frame.time;
    }

    /**ms */
    const elapsed = frame.time - this.baseTime;
    if (elapsed < 0 || elapsed < this.lastCommited) {
      return;
    }
    const index = int(elapsed / this.interval) % this.bufferLength;
    this.audioBuffer[index].push({
      frame,
      elapsed,
      kind: "audio",
      seq: frame.sequence,
    });

    this.start();
  };

  processVideoInput = ({ frame, eol }: LipsyncInput) => {
    if (!frame) {
      this.stopped = true;
      this.videoOutput({ eol });
      return;
    }
    if (this.stopped) {
      return;
    }

    if (this.baseTime == undefined) {
      this.baseTime = frame.time;
    }

    /**ms */
    const elapsed = frame.time - this.baseTime;
    if (elapsed < 0 || elapsed < this.lastCommited) {
      return;
    }
    const index = int(elapsed / this.interval) % this.bufferLength;
    this.videoBuffer[index].push({
      frame,
      elapsed,
      kind: "video",
      seq: frame.sequence,
    });

    this.start();
  };
}

export interface LipSyncOptions {
  interval: number;
  bufferLength: number;
}
