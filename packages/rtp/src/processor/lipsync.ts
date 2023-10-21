import { randomUUID } from "crypto";

import { int } from "..";
import { CodecFrame } from "./depacketizer";
import { AVProcessor } from "./interface";
import { MediaKind } from "./webm";

export type LipsyncInput = {
  frame?: CodecFrame;
  eol?: boolean;
};

export type LipsyncOutput = {
  frame?: CodecFrame;
  eol?: boolean;
};

export class LipsyncBase implements AVProcessor<LipsyncInput> {
  private id = randomUUID();
  bufferLength: number;
  /**ms */
  baseTime?: number;
  audioBuffer: {
    frame: CodecFrame;
    kind: MediaKind;
    [key: string]: any;
  }[][];
  videoBuffer: { frame: CodecFrame; kind: MediaKind }[][];
  stopped = false;
  /**ms */
  private interval: number;
  /**ms */
  private bufferDuration: number;
  private ptime: number;
  private index = 0;
  private currentTimestamp!: number;
  /**ms */
  private lastCommittedTime = 0;
  private lastExecutionTime = 0;
  private internalStats = {};
  /**ms */
  private lastFrameReceivedAt = 0;

  constructor(
    private audioOutput: (output: LipsyncOutput) => void,
    private videoOutput: (output: LipsyncOutput) => void,
    private options: Partial<LipSyncOptions> = {}
  ) {
    this.interval = this.options.syncInterval ?? 500;
    this.bufferDuration = this.interval / 2;
    this.bufferLength = (this.options.bufferLength ?? 10) * 2;
    this.audioBuffer = [...new Array(this.bufferLength)].map(() => []);
    this.videoBuffer = [...new Array(this.bufferLength)].map(() => []);
    this.ptime = this.options.ptime ?? 20;
  }

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
      id: this.id,
      audioBufferLength: this.audioBuffer.flatMap((v) => v).length,
      videoBufferLength: this.videoBuffer.flatMap((v) => v).length,
      baseTime: this.baseTime,
      lastCommittedTimeSec: this.lastCommittedTime / 1000,
    };
  }

  private executeTask() {
    const audioBuffer = this.audioBuffer[this.index].sort(
      (a, b) => a.frame.time - b.frame.time
    );

    if (this.options.fillDummyAudioPacket) {
      const last = audioBuffer.at(-1);
      const expect = last
        ? last.frame.time +
          // offset
          this.ptime
        : this.currentTimestamp;

      // パケット間の損失/muteはdtxプラグインでダミーパケットを挿入する
      // interval中のパケットが途中から無いもしくはinterval中にパケットが無い場合はここでダミーパケットを挿入する
      const audioDiff = this.currentTimestamp + this.bufferDuration - expect;
      if (audioDiff > 0) {
        for (
          let time = expect;
          time < this.currentTimestamp + this.bufferDuration;
          time += this.ptime
        ) {
          audioBuffer.push({
            frame: {
              time,
              data: this.options.fillDummyAudioPacket,
              isKeyframe: true,
            },
            kind: "audio",
          });
          this.internalStats["pushDummyPacket"] = {
            count: (this.internalStats["pushDummyPacket"]?.count ?? 0) + 1,
            at: new Date().toISOString(),
            time,
          };
        }
      }
    }
    this.currentTimestamp += this.bufferDuration;
    const joined = [...audioBuffer, ...this.videoBuffer[this.index]].filter(
      (b) => b.frame.time >= this.lastCommittedTime
    );
    const sorted = joined.sort((a, b) => a.frame.time - b.frame.time);
    this.audioBuffer[this.index] = [];
    this.videoBuffer[this.index] = [];

    for (const output of sorted) {
      if (output.kind === "audio") {
        this.audioOutput(output);
      } else {
        this.videoOutput(output);
      }
      this.internalStats["lipsync"] = new Date().toISOString();
      this.lastCommittedTime = output.frame.time;
    }

    this.index++;
    if (this.index === this.bufferLength) {
      this.index = 0;
    }
  }

  private stop() {
    this.stopped = true;
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

    this.processInput(frame, this.audioBuffer, "audio");
  };

  processVideoInput = ({ frame, eol }: LipsyncInput) => {
    if (!frame) {
      this.videoOutput({ eol });
      this.stop();
      this.videoOutput = undefined as any;
      return;
    }

    this.processInput(frame, this.videoBuffer, "video");
  };

  private processInput = (
    frame: CodecFrame,
    buffer: {
      frame: CodecFrame;
      kind: MediaKind;
    }[][],
    kind: MediaKind
  ) => {
    if (this.stopped) {
      return;
    }

    if (this.baseTime == undefined) {
      this.baseTime = frame.time;
      this.currentTimestamp = this.baseTime;
      this.lastExecutionTime = this.baseTime;
      this.lastCommittedTime = this.baseTime;
      this.lastFrameReceivedAt = Date.now();
    }

    // 過去のフレームを捨てる
    if (frame.time < this.lastCommittedTime) {
      return;
    }

    // NTPの同期ずれが疑われるので捨てる
    const now = Date.now();
    const gap = 5000; // RTCP SR interval;
    const lastCommittedElapsed = frame.time - this.lastCommittedTime;
    const lastFrameReceivedElapsed = now - this.lastFrameReceivedAt;
    if (gap < lastFrameReceivedElapsed && lastCommittedElapsed < gap) {
      this.internalStats["invalidFrameTime"] = {
        count: (this.internalStats["invalidFrameTime"]?.count ?? 0) + 1,
        at: new Date().toISOString(),
        lastCommittedElapsed,
        lastFrameReceivedElapsed,
      };
      return;
    }
    this.lastFrameReceivedAt = now;

    const elapsed = frame.time - this.baseTime;
    const index = int(elapsed / this.bufferDuration) % this.bufferLength;
    buffer[index].push({
      frame,
      kind,
    });

    const diff = frame.time - this.lastExecutionTime;
    if (diff >= this.interval) {
      const times = int(diff / this.bufferDuration) - 1;
      this.lastExecutionTime = this.currentTimestamp;
      for (let i = 0; i < times; i++) {
        this.executeTask();
        this.lastExecutionTime += this.bufferDuration;
      }
    }
    return;
  };
}

export interface LipSyncOptions {
  /**ms */
  syncInterval: number;
  /**
   * int
   * @description syncInterval * bufferLength = max packet lifetime
   * */
  bufferLength: number;
  fillDummyAudioPacket: Buffer;
  ptime: number;
}
