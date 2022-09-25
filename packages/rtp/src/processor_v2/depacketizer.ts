import { TransformStream } from "stream/web";

import { RtpHeader, RtpPacket } from "..";
import { dePacketizeRtpPackets } from "../codec";
import { enumerate } from "../helper";

export interface DepacketizerInput {
  rtp: RtpPacket;
}

export interface DepacketizerOutput {
  frame: { data: Buffer; isKeyframe: boolean; timestamp: number };
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
    codec: string
  ) {
    this.transform = new TransformStream({
      transform: (input, output) => {
        const packets = this.onRtp(input.rtp);
        if (packets) {
          try {
            const { data, isKeyframe } = dePacketizeRtpPackets(codec, packets);

            if (this.packetLostHappened) {
              if (isKeyframe) {
                this.packetLostHappened = false;
              } else {
                console.log("skip");
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
    // if (this.lastSeqNum != undefined) {
    //   if (uint16Add(this.lastSeqNum, 1) !== rtp.header.sequenceNumber) {
    //     // packet loss happened
    //     console.log("packet loss happened");
    //     this.packetLostHappened = true;
    //     this.buffering = [];
    //   }
    // }

    this.buffering.push(rtp);
    this.lastSeqNum = rtp.header.sequenceNumber;

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
