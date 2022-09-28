import debug from "debug";
import { TransformStream } from "stream/web";

import { RtpHeader, RtpPacket, uint16Add } from "..";
import { dePacketizeRtpPackets } from "../codec";
import { enumerate } from "../helper";
import { RtpOutput } from "./source/rtp";

const srcPath = `werift-rtp : packages/rtp/src/processor_v2/depacketizer.ts`;
const log = debug(srcPath);

export type DepacketizerInput = RtpOutput;

export interface DepacketizerOutput {
  frame?: { data: Buffer; isKeyframe: boolean; timestamp: number };
  eol?: boolean;
}

export const depacketizeTransformer = (
  ...args: ConstructorParameters<typeof DepacketizeTransformer>
) => new DepacketizeTransformer(...args).transform;

class DepacketizeTransformer {
  private buffering: RtpPacket[] = [];

  transform: TransformStream<DepacketizerInput, DepacketizerOutput>;
  packetLostHappened = false;

  constructor(
    private isFinalPacketInSequence: (header: RtpHeader) => boolean,
    codec: string,
    options: { waitForKeyframe?: boolean } = {}
  ) {
    this.transform = new TransformStream({
      transform: (input, output) => {
        if (!input.rtp) {
          if (input.eol) {
            output.enqueue({ eol: true });
          }
          return;
        }

        const packets = this.onRtp(input.rtp);
        if (packets) {
          try {
            const { data, isKeyframe } = dePacketizeRtpPackets(codec, packets);

            if (this.packetLostHappened) {
              if (isKeyframe) {
                this.packetLostHappened = false;
              } else if (options.waitForKeyframe) {
                return;
              }
            }

            output.enqueue({
              frame: {
                data,
                isKeyframe,
                timestamp: packets[0].header.timestamp,
              },
            });
          } catch (error) {}
        }
      },
    });
  }

  lastSeqNum?: number;
  private onRtp(rtp: RtpPacket) {
    const { sequenceNumber } = rtp.header;
    if (this.lastSeqNum != undefined) {
      const expect = uint16Add(this.lastSeqNum, 1);
      if (sequenceNumber < expect) {
        return;
      }
      if (sequenceNumber > expect) {
        log("packet lost happened", { expect, sequenceNumber });
        this.packetLostHappened = true;
        this.buffering = [];
      }
    }

    this.buffering.push(rtp);
    this.lastSeqNum = sequenceNumber;

    let finalPacket: number | undefined;
    for (const [i, p] of enumerate(this.buffering)) {
      if (this.isFinalPacketInSequence(p.header)) {
        finalPacket = i;
        break;
      }
    }
    if (finalPacket == undefined) {
      return;
    }

    const packets = this.buffering;
    this.buffering = [];

    return packets;
  }
}
