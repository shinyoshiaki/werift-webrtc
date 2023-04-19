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
  audioBuffer: { frame: CodecFrame; kind: string }[][];
  videoBuffer: { frame: CodecFrame; kind: string }[][];
  stopped = false;
  /**ms */
  private interval: number;
  private started = false;
  /**ms */
  lastCommittedTime = 0;
  private intervalId?: any;

  constructor(
    private audioOutput: (output: LipsyncOutput) => void,
    private videoOutput: (output: LipsyncOutput) => void,
    private options: Partial<LipSyncOptions> = {}
  ) {
    this.interval = this.options.syncInterval ?? 500;
    this.bufferLength = this.options.bufferingTimes ?? 10;
    this.audioBuffer = [...new Array(this.bufferLength)].map(() => []);
    this.videoBuffer = [...new Array(this.bufferLength)].map(() => []);
  }

  toJSON(): Record<string, any> {
    return {
      audioBufferLength: this.audioBuffer.flatMap((v) => v).length,
      videoBufferLength: this.videoBuffer.flatMap((v) => v).length,
      baseTime: this.baseTime,
      lastCommittedTimeSec: this.lastCommittedTime / 1000,
    };
  }

  private startIfNeed() {
    // 2列目にカーソルが移ってから処理を始めることで1列目の処理を完了できる
    if ([...this.audioBuffer[1], ...this.videoBuffer[1]].length === 0) {
      return;
    }

    if (this.started) {
      return;
    }
    this.started = true;

    let index = 0;
    let currentTimestamp = this.baseTime!;
    const task = () => {
      const audioBuffer = this.audioBuffer[index].sort(
        (a, b) => a.frame.time - b.frame.time
      );

      if (this.options.fillDummyAudioPacket) {
        const last = audioBuffer.at(-1);
        const expect = last ? last.frame.time + 20 : currentTimestamp;

        // パケット間の損失/muteはdtxプラグインでダミーパケットを挿入する
        // interval中のパケットが途中から無いもしくはinterval中にパケットが無い場合はここでダミーパケットを挿入する
        if (expect < currentTimestamp + this.interval) {
          for (
            let time = expect;
            time < currentTimestamp + this.interval;
            time += 20
          ) {
            audioBuffer.push({
              frame: {
                time,
                data: this.options.fillDummyAudioPacket,
                isKeyframe: true,
              },
              kind: "audio",
            });
          }
        }
        currentTimestamp += this.interval;
      }
      const joined = [...audioBuffer, ...this.videoBuffer[index]].filter(
        (b) => b.frame.time >= this.lastCommittedTime
      );
      const sorted = joined.sort((a, b) => a.frame.time - b.frame.time);
      this.audioBuffer[index] = [];
      this.videoBuffer[index] = [];

      for (const output of sorted) {
        if (output.kind === "audio") {
          this.audioOutput(output);
        } else {
          this.videoOutput(output);
        }
        this.lastCommittedTime = output.frame.time;
      }

      index++;
      if (index === this.bufferLength) {
        index = 0;
      }
    };
    this.intervalId = setInterval(task, this.interval);
  }

  private stop() {
    this.stopped = true;
    clearInterval(this.intervalId);
    this.audioBuffer = [];
    this.videoBuffer = [];
  }

  processAudioInput = ({ frame, eol }: LipsyncInput) => {
    if (!frame) {
      this.audioOutput({ eol });
      this.stop();
      this.audioOutput = undefined as any;
      return;
    }
    if (this.stopped) {
      return;
    }

    if (this.baseTime == undefined) {
      this.baseTime = frame.time;
    }

    /**ms */
    const elapsed = frame.time - this.baseTime!;
    if (elapsed < 0 || frame.time < this.lastCommittedTime) {
      return;
    }
    const index = int(elapsed / this.interval) % this.bufferLength;
    this.audioBuffer[index].push({
      frame,
      kind: "audio",
    });

    this.startIfNeed();
  };

  processVideoInput = ({ frame, eol }: LipsyncInput) => {
    if (!frame) {
      this.videoOutput({ eol });
      this.stop();
      this.videoOutput = undefined as any;
      return;
    }
    if (this.stopped) {
      return;
    }

    if (this.baseTime == undefined) {
      this.baseTime = frame.time;
    }

    /**ms */
    const elapsed = frame.time - this.baseTime!;
    if (elapsed < 0 || frame.time < this.lastCommittedTime) {
      return;
    }
    const index = int(elapsed / this.interval) % this.bufferLength;
    this.videoBuffer[index].push({
      frame,
      kind: "video",
    });

    this.startIfNeed();
  };
}

export interface LipSyncOptions {
  /**ms */
  syncInterval: number;
  /**
   * int
   * @description syncInterval * bufferingTimes=bufferTimeLength
   * */
  bufferingTimes: number;
  fillDummyAudioPacket: Buffer;
}
