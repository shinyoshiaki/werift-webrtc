import debug from "debug";
import Event from "rx.mini";

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

export interface DepacketizerOptions {
  isFinalPacketInSequence?: (header: RtpHeader) => boolean;
  waitForKeyframe?: boolean;
}

export class DepacketizeBase
  implements Processor<DepacketizerInput, DepacketizerOutput>
{
  private buffering: DepacketizerInput[] = [];
  private lastSeqNum?: number;
  private frameBroken = false;
  private keyframeReceived = false;
  count = 0;
  readonly onNeedKeyFrame = new Event();
  private internalStats = {};

  constructor(
    private codec: string,
    private options: DepacketizerOptions = {}
  ) {}

  toJSON(): Record<string, any> {
    return {
      bufferingLength: this.buffering.length,
      lastSeqNum: this.lastSeqNum,
      count: this.count,
      stats: this.internalStats,
    };
  }

  processInput(input: DepacketizerInput): DepacketizerOutput[] {
    const output: DepacketizerOutput[] = [];
    if (!input.rtp) {
      if (input.eol) {
        output.push({ eol: true });
        this.stop();
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
            this.keyframeReceived = true;
          }

          if (this.options.waitForKeyframe && this.keyframeReceived === false) {
            this.onNeedKeyFrame.execute();
            return [];
          }

          if (!this.frameBroken) {
            const time = this.buffering.at(-1)?.time ?? 0;
            output.push({
              frame: {
                data,
                isKeyframe,
                time,
                sequence: this.count++,
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
          log("error", error, { input, codec: this.codec });
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
            sequence: this.count++,
            rtpSeq: sequence,
            timestamp,
          },
        });
        return output;
      } catch (error) {
        log("error", error, { input, codec: this.codec });
      }
    }
    return [];
  }

  private stop() {
    this.clearBuffer();
    this.onNeedKeyFrame.allUnsubscribe();
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
        this.internalStats["unExpect"] = {
          expect,
          sequenceNumber,
          codec: this.codec,
          at: new Date().toISOString(),
          count: (this.internalStats["unExpect"]?.count ?? 0) + 1,
        };
        return false;
      }
      if (uint16Gt(sequenceNumber, expect)) {
        this.internalStats["packetLost"] = {
          expect,
          sequenceNumber,
          codec: this.codec,
          at: new Date().toISOString(),
          count: (this.internalStats["packetLost"]?.count ?? 0) + 1,
        };
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
