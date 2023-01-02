import debug from "debug";

import { RtpHeader, RtpPacket, uint16Add, uint16Gt } from "..";
import { dePacketizeRtpPackets } from "../codec";
import { enumerate } from "../helper";
import { Processor } from "./interface";

const path = `werift-rtp : packages/rtp/src/processor/depacketizer.ts`;
const log = debug(path);

export type DepacketizerInput = {
  rtp?: RtpPacket;
  /**ms */
  time?: number;
  eol?: boolean;
};

export interface DepacketizerOutput {
  frame?: CodecFrame;
  eol?: boolean;
}

export interface CodecFrame {
  data: Buffer;
  isKeyframe: boolean;
  /**ms */
  time: number;
  [key: string]: any;
}

export class DepacketizeBase
  implements Processor<DepacketizerInput, DepacketizerOutput>
{
  private buffering: DepacketizerInput[] = [];
  private lastSeqNum?: number;
  private frameBroken = false;
  sequence = 0;

  constructor(
    private codec: string,
    private options: {
      isFinalPacketInSequence?: (header: RtpHeader) => boolean;
    } = {}
  ) {}

  processInput(input: DepacketizerInput): DepacketizerOutput[] {
    const output: DepacketizerOutput[] = [];
    if (!input.rtp) {
      if (input.eol) {
        output.push({ eol: true });
      }
      return output;
    }

    if (this.options.isFinalPacketInSequence) {
      const isFinal = this.checkFinalPacket(input);
      if (isFinal) {
        try {
          const { data, isKeyframe, sequence, timestamp } =
            dePacketizeRtpPackets(
              this.codec,
              this.buffering.map((b) => b.rtp!)
            );

          if (isKeyframe) {
            log("isKeyframe", this.codec);
          }

          if (!this.frameBroken) {
            const time = this.buffering.at(-1)?.time ?? 0;
            output.push({
              frame: {
                data,
                isKeyframe,
                time,
                sequence: this.sequence++,
                rtpSeq: sequence,
                timestamp,
              },
            });
          }

          if (this.frameBroken) {
            this.frameBroken = false;
          }

          this.clearBuffer();

          return output;
        } catch (error) {
          log("error", error, input);
          this.clearBuffer();
        }
      }
    } else {
      try {
        const { data, isKeyframe, sequence, timestamp } = dePacketizeRtpPackets(
          this.codec,
          [input.rtp]
        );
        output.push({
          frame: {
            data,
            isKeyframe,
            time: input.time!,
            sequence: this.sequence++,
            rtpSeq: sequence,
            timestamp,
          },
        });
        return output;
      } catch (error) {
        log("error", error, input);
      }
    }
    return [];
  }

  private clearBuffer() {
    this.buffering.forEach((b) => b.rtp!.clear());
    this.buffering = [];
  }

  private checkFinalPacket({ rtp, time }: DepacketizerInput): boolean {
    if (!this.options.isFinalPacketInSequence) {
      throw new Error("isFinalPacketInSequence not exist");
    }

    const { sequenceNumber } = rtp!.header;
    if (this.lastSeqNum != undefined) {
      const expect = uint16Add(this.lastSeqNum, 1);
      if (uint16Gt(expect, sequenceNumber)) {
        log("unexpect", { expect, sequenceNumber });
        return false;
      }
      if (uint16Gt(sequenceNumber, expect)) {
        log("packet lost happened", { expect, sequenceNumber });
        this.frameBroken = true;
        this.clearBuffer();
      }
    }

    this.buffering.push({ rtp, time });
    this.lastSeqNum = sequenceNumber;

    let finalPacket: number | undefined;
    for (const [i, { rtp }] of enumerate(this.buffering)) {
      if (this.options.isFinalPacketInSequence(rtp!.header)) {
        finalPacket = i;
        break;
      }
    }
    if (finalPacket == undefined) {
      return false;
    }

    return true;
  }
}
