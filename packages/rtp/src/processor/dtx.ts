import { randomUUID } from "crypto";
import { CodecFrame, DepacketizerOutput, Processor } from "werift-rtp";

export type DtxInput = DepacketizerOutput;

export type DtxOutput = DtxInput;

export class DtxBase implements Processor<DtxInput, DtxOutput> {
  readonly id = randomUUID();
  previousTimestamp?: number;
  private fillCount = 0;
  constructor(public ptime: number, private dummyPacket: Buffer) {}

  toJSON(): Record<string, any> {
    return { id: this.id, fillCount: this.fillCount };
  }

  processInput({ frame, eol }: DtxInput): DtxOutput[] {
    if (eol) {
      return [{ eol: true }];
    }

    if (frame) {
      if (!this.previousTimestamp) {
        this.previousTimestamp = frame.time;
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
        return [...dummyPackets, { frame }];
      } else {
        this.previousTimestamp = frame.time;
        return [{ frame }];
      }
    }

    return [];
  }
}
