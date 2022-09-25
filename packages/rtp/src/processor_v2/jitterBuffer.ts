import debug from "debug";
import { TransformStream } from "stream/web";

import { RequireAtLeastOne, RtpPacket, uint16Add, uint32Add } from "..";
import { RtpInput, RtpOutput } from "./interface";

const log = debug("packages/rtp/src/processor_v2/jitterBuffer.ts");

export type JitterBufferInput = RtpInput;

export interface JitterBufferOutput extends RtpOutput {
  isPacketLost?: { from: number; to: number };
}

export const jitterBufferTransformer = (
  ...args: ConstructorParameters<typeof JitterBufferTransformer>
) => new JitterBufferTransformer(...args).transform;

export class JitterBufferTransformer {
  transform: TransformStream<JitterBufferInput, JitterBufferOutput>;
  options: JitterBufferOptions;
  presentSeqNum?: number;
  rtpBuffer: { [sequenceNumber: number]: RtpPacket } = {};

  private get expectNextSeqNum() {
    return uint16Add(this.presentSeqNum!, 1);
  }

  constructor(
    public clockRate: number,
    options: Partial<JitterBufferOptions> = {}
  ) {
    this.options = {
      latency: options.latency ?? 200,
    };

    this.transform = new TransformStream({
      transform: (input, output) => {
        const { packets, timeoutSeqNum } = this.processRtp(input.rtp);

        if (timeoutSeqNum != undefined) {
          const isPacketLost = {
            from: this.expectNextSeqNum,
            to: timeoutSeqNum,
          };
          this.presentSeqNum = input.rtp.header.sequenceNumber;
          output.enqueue({ isPacketLost });
        } else if (packets != undefined) {
          packets.forEach((rtp) => output.enqueue({ rtp }));
        }
      },
    });
  }

  private processRtp(rtp: RtpPacket): RequireAtLeastOne<{
    packets: RtpPacket[];
    timeoutSeqNum: number;
    nothing: undefined;
  }> {
    const seqNum = rtp.header.sequenceNumber;

    if (this.presentSeqNum == undefined) {
      this.presentSeqNum = seqNum;
      return { packets: [rtp] };
    }

    if (seqNum <= this.presentSeqNum) {
      return { nothing: undefined };
    }

    if (seqNum === this.expectNextSeqNum) {
      this.presentSeqNum = seqNum;
      const rtpBuffer = this.resolveBuffer(uint16Add(seqNum, 1));
      if (rtpBuffer.length > 0) {
        this.presentSeqNum = rtpBuffer.at(-1)?.header.sequenceNumber;
      }
      return { packets: [rtp, ...rtpBuffer] };
    }

    this.rtpBuffer[seqNum] = rtp;
    const timeoutSeqNum = this.disposeTimeoutPackets(rtp.header.timestamp);
    if (timeoutSeqNum) {
      return { timeoutSeqNum };
    } else {
      return { nothing: undefined };
    }
  }

  private resolveBuffer(seqNumFrom: number) {
    const resolve: RtpPacket[] = [];
    let index = seqNumFrom;
    for (; ; index = uint16Add(index, 1)) {
      const rtp = this.rtpBuffer[index];
      if (rtp) {
        resolve.push(rtp);
        delete this.rtpBuffer[index];
      } else {
        break;
      }
    }
    return resolve;
  }

  private disposeTimeoutPackets(baseTimestamp: number) {
    let newestTimeoutSeqNum: number | undefined;

    Object.values(this.rtpBuffer).forEach((rtp) => {
      const elapsed =
        uint32Add(baseTimestamp, -rtp.header.timestamp) / this.clockRate;
      if (elapsed > this.options.latency) {
        log("timeout packet", rtp.header.sequenceNumber);
        delete this.rtpBuffer[rtp.header.sequenceNumber];

        if (newestTimeoutSeqNum == undefined) {
          newestTimeoutSeqNum = rtp.header.sequenceNumber;
        }
        // 現在のSeqNumとの差が最も大きいSeqNumを探す
        if (
          uint16Add(rtp.header.sequenceNumber, -this.presentSeqNum!) >
          uint16Add(newestTimeoutSeqNum!, -this.presentSeqNum!)
        ) {
          newestTimeoutSeqNum = rtp.header.sequenceNumber;
        }
      }
    });

    return newestTimeoutSeqNum;
  }
}

export interface JitterBufferOptions {
  /**milliseconds */
  latency: number;
}
