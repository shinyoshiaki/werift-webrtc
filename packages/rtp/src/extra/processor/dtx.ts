import { randomUUID } from "crypto";

import { CodecFrame, DepacketizerOutput } from "./depacketizer";
import { Processor } from "./interface";

export type DtxInput = DepacketizerOutput;

export type DtxOutput = DtxInput;

export class DtxBase implements Processor<DtxInput, DtxOutput> {
  readonly id = randomUUID();
  previousTimestamp?: number;
  private fillCount = 0;
  private internalStats = {};
  constructor(
    public ptime: number,
    private dummyPacket: Buffer,
  ) {}

  toJSON(): Record<string, any> {
    return { ...this.internalStats, id: this.id, fillCount: this.fillCount };
  }

  processInput({ frame, eol }: DtxInput): DtxOutput[] {
    if (eol) {
      this.stop();
      return [{ eol: true }];
    }

    if (frame) {
      if (!this.previousTimestamp) {
        this.previousTimestamp = frame.time;
        this.internalStats["dtx"] = new Date().toISOString();
        return [{ frame }];
      }

      if (frame.time != this.previousTimestamp + this.ptime) {
        const dummyPackets: { frame: CodecFrame }[] = [];
        for (
          let time = this.previousTimestamp;
          time < frame.time;
          time += this.ptime
        ) {
          dummyPackets.push({
            frame: {
              time,
              isKeyframe: frame.isKeyframe,
              data: this.dummyPacket,
            },
          });
          this.fillCount++;
        }

        this.previousTimestamp = frame.time;
        this.internalStats["dtx"] = new Date().toISOString();
        return [...dummyPackets, { frame }];
      } else {
        this.previousTimestamp = frame.time;
        this.internalStats["dtx"] = new Date().toISOString();
        return [{ frame }];
      }
    }

    return [];
  }

  private stop() {
    this.dummyPacket = undefined as any;
  }
}
