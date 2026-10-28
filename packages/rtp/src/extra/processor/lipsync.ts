import { randomUUID } from "crypto";

import { int } from "../..";
import type { CodecFrame } from "./depacketizer";
import type { AVProcessor } from "./interface";
import type { MediaKind } from "./webm";

export type LipsyncInput = {
  frame?: CodecFrame;
  eol?: boolean;
};

export type LipsyncOutput = {
  frame?: CodecFrame;
  eol?: boolean;
};

export class LipsyncBase implements AVProcessor<LipsyncInput> {
  private id = randomUUID().toString();
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
  /** newest frame time per kind (ms) */
  private readonly latestTime: Partial<Record<MediaKind, number>> = {};
  /** kinds in use (piped, or with input) and the ones that ended */
  protected readonly kinds = new Set<MediaKind>();
  private readonly endedKinds = new Set<MediaKind>();

  constructor(
    private audioOutput: (output: LipsyncOutput) => void,
    private videoOutput: (output: LipsyncOutput) => void,
    private options: Partial<LipSyncOptions> = {},
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
      audioBufferLength: this.audioBuffer.flat().length,
      videoBufferLength: this.videoBuffer.flat().length,
      baseTime: this.baseTime,
      lastCommittedTimeSec: this.lastCommittedTime / 1000,
    };
  }

  private executeTask() {
    const audioBuffer = this.audioBuffer[this.index].sort(
      (a, b) => a.frame.time - b.frame.time,
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
      (b) => b.frame.time >= this.lastCommittedTime,
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

  /**
   * Time up to which buffered frames may be output: the slowest kind still
   * running, so a kind that lags (a jitter buffer waiting for a lost packet)
   * is not dropped as too old once the other kind has moved on. Bounded by
   * the ring of buffers, which must not wrap over frames not yet output.
   */
  private commitFrontier() {
    // A kind in use that has no frame yet has not progressed at all.
    const running = [...this.kinds]
      .filter((kind) => !this.endedKinds.has(kind))
      .map((kind) => this.latestTime[kind] ?? this.baseTime!);
    const all = Object.values(this.latestTime) as number[];
    const newest = Math.max(...all);
    const slowest = running.length > 0 ? Math.min(...running) : newest;
    const capacity = (this.bufferLength - 2) * this.bufferDuration;
    return Math.max(slowest, newest - capacity);
  }

  private stop() {
    this.stopped = true;
    this.audioBuffer = [];
    this.videoBuffer = [];
  }

  /**
   * End of stream of one kind. The other kind may still be draining (e.g. its
   * jitter buffer outputs what it held at its own end of stream), so the
   * processor only ends when every kind in use has ended: then what is still
   * buffered is output in time order, followed by the end of each kind.
   */
  private end(kind: MediaKind) {
    this.kinds.add(kind);
    this.endedKinds.add(kind);
    if ([...this.kinds].some((k) => !this.endedKinds.has(k))) {
      return;
    }
    this.flush();
    const audioOutput = this.audioOutput;
    const videoOutput = this.videoOutput;
    this.stop();
    this.audioOutput = undefined as any;
    this.videoOutput = undefined as any;
    if (this.endedKinds.has("audio")) audioOutput?.({ eol: true });
    if (this.endedKinds.has("video")) videoOutput?.({ eol: true });
  }

  /** Output what is still buffered (the last sync interval) in time order. */
  private flush() {
    if (this.stopped) {
      return;
    }
    const buffered = [...this.audioBuffer.flat(), ...this.videoBuffer.flat()]
      .filter((b) => b.frame.time >= this.lastCommittedTime)
      .sort((a, b) => a.frame.time - b.frame.time);
    for (const output of buffered) {
      if (output.kind === "audio") {
        this.audioOutput?.(output);
      } else {
        this.videoOutput?.(output);
      }
      this.lastCommittedTime = output.frame.time;
    }
  }

  processAudioInput = ({ frame }: LipsyncInput) => {
    if (!frame) {
      this.end("audio");
      return;
    }

    this.processInput(frame, this.audioBuffer, "audio");
  };

  processVideoInput = ({ frame }: LipsyncInput) => {
    if (!frame) {
      this.end("video");
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
    kind: MediaKind,
  ) => {
    if (this.stopped) {
      return;
    }
    this.kinds.add(kind);

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

    this.latestTime[kind] = Math.max(
      this.latestTime[kind] ?? frame.time,
      frame.time,
    );
    const diff = this.commitFrontier() - this.lastExecutionTime;
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
