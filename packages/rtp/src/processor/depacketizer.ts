import debug from "debug";

import { RtpHeader, RtpPacket, uint16Add } from "..";
import { dePacketizeRtpPackets } from "../codec";
import { enumerate } from "../helper";
import { Processor } from "./interface";
import { RtpOutput } from "./source";

const srcPath = `werift-rtp : packages/rtp/src/processor_v2/depacketizer.ts`;
const log = debug(srcPath);

export type DepacketizerInput = RtpOutput;

export interface DepacketizerOutput {
  frame?: { data: Buffer; isKeyframe: boolean; timestamp: number };
  eol?: boolean;
}

export class DepacketizeBase
  implements Processor<DepacketizerInput, DepacketizerOutput>
{
  private buffering: RtpPacket[] = [];
  private lastSeqNum?: number;
  private frameBroken = false;

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
      const isFinal = this.checkFinalPacket(input.rtp);
      if (isFinal) {
        try {
          const { timestamp } = this.buffering[0].header;
          const { data, isKeyframe } = dePacketizeRtpPackets(
            this.codec,
            this.buffering
          );
          this.clearBuffer();

          if (isKeyframe) {
            // console.log("isKeyframe", this.codec);
          }

          if (!this.frameBroken) {
            output.push({
              frame: {
                data,
                isKeyframe,
                timestamp,
              },
            });
          }

          if (this.frameBroken) {
            this.frameBroken = false;
          }

          return output;
        } catch (error) {
          log("error", error, input);
          this.clearBuffer();
        }
      }
    } else {
      try {
        const { data, isKeyframe } = dePacketizeRtpPackets(this.codec, [
          input.rtp,
        ]);
        output.push({
          frame: {
            data,
            isKeyframe,
            timestamp: input.rtp.header.timestamp,
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
    this.buffering.forEach((b) => b.clear());
    this.buffering = [];
  }

  private checkFinalPacket(rtp: RtpPacket): boolean {
    if (!this.options.isFinalPacketInSequence) {
      throw new Error("isFinalPacketInSequence not exist");
    }

    const { sequenceNumber } = rtp.header;
    if (this.lastSeqNum != undefined) {
      const expect = uint16Add(this.lastSeqNum, 1);
      if (sequenceNumber < expect) {
        return false;
      }
      if (sequenceNumber > expect) {
        log("packet lost happened", { expect, sequenceNumber });
        this.frameBroken = true;
        this.clearBuffer();
      }
    }

    this.buffering.push(rtp);
    this.lastSeqNum = sequenceNumber;

    let finalPacket: number | undefined;
    for (const [i, p] of enumerate(this.buffering)) {
      if (this.options.isFinalPacketInSequence(p.header)) {
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
