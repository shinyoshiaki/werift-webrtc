import { randomUUID } from "crypto";

import { CodecFrame, DepacketizerOutput } from "./depacketizer";
import { Processor } from "./interface";

export type MuteInput = DepacketizerOutput;

export type MuteOutput = MuteInput;

export class MuteHandlerBase implements Processor<MuteInput, MuteOutput> {
  readonly id = randomUUID();
  private buffer: CodecFrame[] = [];
  private started = false;
  private ended = false;
  private intervalId: any;
  private currentTimestamp!: number;

  constructor(
    private output: (o: MuteOutput) => void,
    private props: {
      ptime: number;
      dummyPacket: Buffer;
      interval: number;
      sort?: boolean;
    }
  ) {}

  toJSON(): Record<string, any> {
    return { id: this.id };
  }

  private startIfNeed(baseTimestamp: number) {
    if (this.started) {
      return;
    }
    this.started = true;

    const { sort, interval, ptime, dummyPacket } = this.props;
    this.currentTimestamp = baseTimestamp;
    this.intervalId = setInterval(() => {
      if (this.ended) {
        return;
      }

      if (sort ?? true) {
        this.buffer = this.buffer.sort((a, b) => a.time - b.time);
      }
      const last = this.buffer.at(-1);
      const expect = last ? last.time + ptime : this.currentTimestamp;
      if (expect < this.currentTimestamp + interval) {
        for (
          let time = expect;
          time < this.currentTimestamp + interval;
          time += ptime
        ) {
          this.buffer.push({
            time,
            data: dummyPacket,
            isKeyframe: true,
          });
        }
      }
      this.buffer.forEach((frame) => this.output({ frame }));
      this.buffer = [];

      this.currentTimestamp += interval;
    }, interval);
  }

  private stop() {
    clearInterval(this.intervalId);
    this.ended = true;
    this.buffer = [];
    this.output = undefined as any;
  }

  processInput = ({ frame, eol }: MuteInput): MuteOutput[] => {
    if (eol) {
      this.stop();
      return [{ eol: true }];
    }

    if (frame) {
      this.startIfNeed(frame.time);
      if (frame.time >= this.currentTimestamp) {
        this.buffer.push(frame);
      }
    }

    return [];
  };
}
