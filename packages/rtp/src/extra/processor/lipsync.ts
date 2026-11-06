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
  /** kinds whose first frame is awaited before starting */
  private kinds: MediaKind[];
  /**ms */
  private startTimeout: number;
  /** frames received before the start (before baseTime is fixed) */
  private pendingFrames: { frame: CodecFrame; kind: MediaKind }[] = [];
  /** latest frame time of each kind received before the start */
  private pendingLatestTime: Partial<Record<MediaKind, number>> = {};
  /** wall clock (ms) when the first pending frame was received */
  private pendingSince?: number;
  private startTimer?: ReturnType<typeof setTimeout>;

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
    this.kinds = [
      ...new Set<MediaKind>(this.options.kinds ?? ["audio", "video"]),
    ];
    this.startTimeout = this.options.startTimeout ?? 10_000;
  }

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
      id: this.id,
      audioBufferLength: this.audioBuffer.flat().length,
      videoBufferLength: this.videoBuffer.flat().length,
      baseTime: this.baseTime,
      pendingFrameLength: this.pendingFrames.length,
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

  private stop() {
    this.clearStartTimer();
    if (!this.stopped && this.baseTime == undefined) {
      this.startAndDrain();
    }
    this.stopped = true;
    this.pendingFrames = [];
    this.audioBuffer = [];
    this.videoBuffer = [];
  }

  processAudioInput = ({ frame, eol }: LipsyncInput) => {
    if (!frame) {
      this.stop();
      this.audioOutput({ eol });
      this.audioOutput = undefined as any;
      return;
    }

    this.processInput(frame, "audio");
  };

  processVideoInput = ({ frame, eol }: LipsyncInput) => {
    if (!frame) {
      this.stop();
      this.videoOutput({ eol });
      this.videoOutput = undefined as any;
      return;
    }

    this.processInput(frame, "video");
  };

  private processInput = (frame: CodecFrame, kind: MediaKind) => {
    if (this.stopped) {
      return;
    }

    if (this.baseTime == undefined) {
      this.processPendingInput(frame, kind);
      return;
    }

    this.insertFrame(frame, kind);
  };

  /**
   * Before the start, frames are kept in `pendingFrames` instead of the ring
   * buffer, because a track whose first RTCP SR arrives late delivers its
   * backlog with times older than the frames already received from the other
   * track. Starting on the first frame would discard that backlog.
   *
   * The start timeout is also armed as an (unref'd) timer, so that the pending
   * frames are output even if no further frame arrives. The timer is cleared
   * on start and on `stop()`.
   */
  private processPendingInput(frame: CodecFrame, kind: MediaKind) {
    const now = Date.now();
    if (this.pendingSince == undefined) {
      this.pendingSince = now;
      this.startTimer = setTimeout(
        () => this.startByTimer(),
        this.startTimeout,
      );
      this.startTimer.unref?.();
    }
    this.pendingFrames.push({ frame, kind });
    this.pendingLatestTime[kind] = Math.max(
      this.pendingLatestTime[kind] ?? -Infinity,
      frame.time,
    );

    const latest = this.kinds.map((k) => this.pendingLatestTime[k]);
    const ready =
      latest.every((time) => time != undefined) &&
      // wait until the backlog of the late track has caught up with the
      // others, so that frames after the start are not older than the
      // committed time
      Math.max(...(latest as number[])) - Math.min(...(latest as number[])) <=
        this.bufferDuration;
    const timedOut = now - this.pendingSince >= this.startTimeout;
    if (ready || timedOut) {
      this.start(now);
    }
  }

  private clearStartTimer() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
  }

  /** timeout without further input: output the pending frames immediately */
  private startByTimer() {
    this.startTimer = undefined;
    if (this.stopped || this.baseTime != undefined) {
      return;
    }
    this.startAndDrain();
  }

  /**
   * Starts with the pending frames and runs the ring buffer tasks up to the
   * latest pending frame, so that every output (including the dummy audio
   * fill) goes through the same path as the normal flow.
   */
  private startAndDrain() {
    if (this.pendingFrames.length === 0) {
      return;
    }
    const last = Math.max(...this.pendingFrames.map((p) => p.frame.time));
    this.start(Date.now());
    while (this.currentTimestamp <= last) {
      this.executeTask();
    }
    this.lastExecutionTime = this.currentTimestamp;
  }

  private start(now: number) {
    this.clearStartTimer();
    const pending = this.pendingFrames.sort(
      (a, b) => a.frame.time - b.frame.time,
    );
    this.pendingFrames = [];
    this.pendingLatestTime = {};

    this.baseTime = pending[0].frame.time;
    this.currentTimestamp = this.baseTime;
    this.lastExecutionTime = this.baseTime;
    this.lastCommittedTime = this.baseTime;
    this.lastFrameReceivedAt = now;

    for (const { frame, kind } of pending) {
      this.insertFrame(frame, kind);
    }
  }

  private insertFrame(frame: CodecFrame, kind: MediaKind) {
    const buffer = kind === "audio" ? this.audioBuffer : this.videoBuffer;

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

    const elapsed = frame.time - this.baseTime!;
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
  }
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
  /**
   * kinds of the input tracks. Output starts after a frame of every kind has
   * been received (or after `startTimeout`), so that a track whose first
   * RTCP SR arrives late does not lose its head.
   * Pass `["video"]` / `["audio"]` for a single track.
   * @default ["audio", "video"]
   */
  kinds: MediaKind[];
  /**
   * ms (wall clock). When a frame of some `kinds` has not arrived within this
   * time after the first frame, output starts with the received tracks only,
   * and frames of a track that arrives later are dropped if they are older
   * than the already output position. Until the start, frames are held in
   * memory and output is delayed by up to this time.
   * @default 10000
   */
  startTimeout: number;
}
