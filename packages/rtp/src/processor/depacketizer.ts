import debug from "debug";
import Event from "rx.mini";

import {
  DepacketizerCodec,
  dePacketizeRtpPackets,
  enumerate,
  RtpHeader,
  RtpPacket,
  uint16Add,
  uint16Gt,
} from "..";
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
  private rtpBuffer: DepacketizerInput[] = [];
  private frameFragmentBuffer?: Buffer;
  private lastSeqNum?: number;
  private frameBroken = false;
  private keyframeReceived = false;
  private count = 0;
  readonly onNeedKeyFrame = new Event();
  private internalStats = {};

  constructor(
    private codec: DepacketizerCodec,
    private options: DepacketizerOptions = {}
  ) {}

  toJSON(): Record<string, any> {
    return {
      ...this.internalStats,
      codec: this.codec,
      bufferingLength: this.rtpBuffer.length,
      lastSeqNum: this.lastSeqNum,
      count: this.count,
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
          const { data, isKeyframe, sequence, timestamp, frameFragmentBuffer } =
            dePacketizeRtpPackets(
              this.codec,
              this.rtpBuffer.map((b) => b.rtp!),
              this.frameFragmentBuffer
            );
          this.frameFragmentBuffer = frameFragmentBuffer;

          if (isKeyframe) {
            this.keyframeReceived = true;
          }

          if (this.options.waitForKeyframe && this.keyframeReceived === false) {
            this.onNeedKeyFrame.execute();
            return [];
          }

          if (!this.frameBroken && data.length > 0) {
            const time = this.rtpBuffer.at(-1)?.time ?? 0;
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
            this.internalStats["depacketizer"] = new Date().toISOString();
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
        const { data, isKeyframe, sequence, timestamp, frameFragmentBuffer } =
          dePacketizeRtpPackets(
            this.codec,
            [input.rtp],
            this.frameFragmentBuffer
          );
        this.frameFragmentBuffer = frameFragmentBuffer;
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
        this.internalStats["depacketizer"] = new Date().toISOString();
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
    this.rtpBuffer.forEach((b) => b.rtp!.clear());
    this.rtpBuffer = [];
    this.frameFragmentBuffer = undefined;
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
        this.internalStats["packetLost"] ??= [];
        if (this.internalStats["packetLost"].length > 10) {
          this.internalStats["packetLost"].shift();
        }
        this.internalStats["packetLost"].push({
          expect,
          sequenceNumber,
          codec: this.codec,
          at: new Date().toISOString(),
        });
        this.internalStats["packetLostCount"] ??= 0;
        this.internalStats["packetLostCount"]++;

        this.frameBroken = true;
        this.clearBuffer();
      }
    }

    this.rtpBuffer.push({ rtp, time });
    this.lastSeqNum = sequenceNumber;

    let finalPacket: number | undefined;
    for (const [i, { rtp }] of enumerate(this.rtpBuffer)) {
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
