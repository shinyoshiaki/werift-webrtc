import { randomUUID } from "crypto";

import { int } from "../..";
import { CodecFrame, DepacketizerOutput } from "./depacketizer";
import { Processor } from "./interface";

export type MuteInput = DepacketizerOutput;

export type MuteOutput = MuteInput;

export class MuteHandlerBase implements Processor<MuteInput, MuteOutput> {
  readonly id = randomUUID();
  private buffer: CodecFrame[][];
  private index = 0;
  private ended = false;
  private baseTime?: number;
  private currentTimestamp!: number;
  private internalStats = {};
  /**ms */
  private lastCommittedTime = 0;
  private lastExecutionTime = 0;
  /**ms */
  private interval: number;
  private bufferDuration: number;
  private bufferLength: number;
  /**ms */
  private lastFrameReceivedAt = 0;

  constructor(
    private output: (o: MuteOutput) => void,
    private props: {
      ptime: number;
      dummyPacket: Buffer;
      /**ms
       * @description intervalごとに無音区間に空パケットを挿入する
       */
      interval: number;
      bufferLength: number;
    },
  ) {
    this.interval = props.interval;
    this.bufferDuration = this.interval / 2;
    this.bufferLength = this.props.bufferLength * 2;
    this.buffer = [...new Array(this.bufferLength)].map(() => []);
  }

  toJSON(): Record<string, any> {
    return { ...this.internalStats, id: this.id };
  }

  private executeTask() {
    const { ptime, dummyPacket } = this.props;

    const buffer = this.buffer[this.index].sort((a, b) => a.time - b.time);
    const last = buffer.at(-1);
    const expect = last
      ? last.time +
        // offset
        ptime
      : this.currentTimestamp;

    if (expect < this.currentTimestamp + this.bufferDuration) {
      for (
        let time = expect;
        time < this.currentTimestamp + this.bufferDuration;
        time += ptime
      ) {
        buffer.push({
          time,
          data: dummyPacket,
          isKeyframe: true,
        });
      }
    }
    this.currentTimestamp += this.bufferDuration;
    this.internalStats["mute"] = new Date().toISOString();

    this.buffer[this.index] = [];
    buffer.forEach((frame) => {
      this.output({ frame });
      this.lastCommittedTime = frame.time;
    });

    this.index++;
    if (this.index === this.bufferLength) {
      this.index = 0;
    }
  }

  private stop() {
    this.ended = true;
    this.buffer = [];
    this.output = undefined as any;
  }

  processInput = ({ frame, eol }: MuteInput): MuteOutput[] => {
    if (!frame) {
      this.stop();
      return [{ eol }];
    }

    if (this.ended) {
      return [];
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
      return [];
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
      return [];
    }
    this.lastFrameReceivedAt = now;

    const elapsed = frame.time - this.baseTime;
    const index = int(elapsed / this.bufferDuration) % this.bufferLength;
    this.buffer[index].push(frame);

    const lastExecution = frame.time - this.lastExecutionTime;
    if (lastExecution >= this.interval) {
      const times = int(lastExecution / this.bufferDuration) - 1;
      this.lastExecutionTime = this.currentTimestamp;
      for (let i = 0; i < times; i++) {
        this.executeTask();
        this.lastExecutionTime += this.bufferDuration;
      }
    }

    return [];
  };
}
