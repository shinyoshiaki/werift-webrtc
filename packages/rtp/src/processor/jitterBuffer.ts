import debug from "debug";

import {
  RequireAtLeastOne,
  RtpPacket,
  uint16Add,
  uint32Add,
  uint32Gt,
} from "..";
import { Processor } from "./interface";
import { RtpOutput } from "./source/rtp";

const srcPath = `werift-rtp : packages/rtp/src/processor_v2/jitterBuffer.ts`;
const log = debug(srcPath);

export type JitterBufferInput = RtpOutput;

export interface JitterBufferOutput extends RtpOutput {
  isPacketLost?: { from: number; to: number };
}

export class JitterBufferBase
  implements Processor<JitterBufferInput, JitterBufferOutput>
{
  private options: JitterBufferOptions;
  private presentSeqNum?: number;
  private rtpBuffer: { [sequenceNumber: number]: RtpPacket } = {};
  private get expectNextSeqNum() {
    return uint16Add(this.presentSeqNum!, 1);
  }

  constructor(
    public clockRate: number,
    options: Partial<JitterBufferOptions> = {}
  ) {
    this.options = {
      latency: options.latency ?? 200,
      bufferSize: options.bufferSize ?? 10000,
    };
  }

  processInput(input: JitterBufferInput): JitterBufferOutput[] {
    const output: JitterBufferOutput[] = [];

    if (!input.rtp) {
      if (input.eol) {
        const packets = this.sortAndClearBuffer(this.rtpBuffer);
        for (const rtp of packets) {
          output.push({ rtp });
        }
        output.push({ eol: true });
      }
      return output;
    }

    const { packets, timeoutSeqNum } = this.processRtp(input.rtp);

    if (timeoutSeqNum != undefined) {
      const isPacketLost = {
        from: this.expectNextSeqNum,
        to: timeoutSeqNum,
      };
      this.presentSeqNum = input.rtp.header.sequenceNumber;
      output.push({ isPacketLost });
      if (packets) {
        for (const rtp of [...packets, input.rtp]) {
          output.push({ rtp });
        }
      }
      return output;
    } else {
      if (packets) {
        for (const rtp of packets) {
          output.push({ rtp });
        }
        return output;
      }
      return [];
    }
  }

  private processRtp(rtp: RtpPacket): RequireAtLeastOne<{
    packets: RtpPacket[];
    timeoutSeqNum: number;
    nothing: undefined;
  }> {
    const { sequenceNumber, timestamp } = rtp.header;

    // init
    if (this.presentSeqNum == undefined) {
      this.presentSeqNum = sequenceNumber;
      return { packets: [rtp] };
    }

    // duplicate
    if (sequenceNumber <= this.presentSeqNum) {
      return { nothing: undefined };
    }

    // expect
    if (sequenceNumber === this.expectNextSeqNum) {
      this.presentSeqNum = sequenceNumber;

      const rtpBuffer = this.resolveBuffer(uint16Add(sequenceNumber, 1));
      this.presentSeqNum =
        rtpBuffer.at(-1)?.header.sequenceNumber ?? this.presentSeqNum;

      return { packets: [rtp, ...rtpBuffer] };
    }

    this.pushRtpBuffer(rtp);

    const { latestTimeoutSeqNum, sorted } =
      this.disposeTimeoutPackets(timestamp);

    if (latestTimeoutSeqNum) {
      return { timeoutSeqNum: latestTimeoutSeqNum, packets: sorted };
    } else {
      return { nothing: undefined };
    }
  }

  private pushRtpBuffer(rtp: RtpPacket) {
    if (Object.values(this.rtpBuffer).length > this.options.bufferSize) {
      return;
    }
    this.rtpBuffer[rtp.header.sequenceNumber] = rtp;
  }

  private resolveBuffer(seqNumFrom: number) {
    const resolve: RtpPacket[] = [];

    for (let index = seqNumFrom; ; index = uint16Add(index, 1)) {
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

  private sortAndClearBuffer(rtpBuffer: {
    [sequenceNumber: number]: RtpPacket;
  }) {
    const buffer: RtpPacket[] = [];
    for (let index = this.presentSeqNum ?? 0; ; index = uint16Add(index, 1)) {
      const rtp = rtpBuffer[index];
      if (rtp) {
        buffer.push(rtp);
        delete rtpBuffer[index];
      }
      if (Object.values(rtpBuffer).length === 0) {
        break;
      }
    }
    return buffer;
  }

  private disposeTimeoutPackets(baseTimestamp: number) {
    let latestTimeoutSeqNum: number | undefined;

    const packets = Object.values(this.rtpBuffer)
      .map((rtp) => {
        const { timestamp, sequenceNumber } = rtp.header;

        if (uint32Gt(timestamp, baseTimestamp)) {
          log("gap", { timestamp, baseTimestamp });
          return;
        }

        const elapsedSec =
          uint32Add(baseTimestamp, -timestamp) / this.clockRate;

        if (elapsedSec * 1000 > this.options.latency) {
          log("timeout packet", {
            sequenceNumber,
            elapsedSec,
            baseTimestamp,
            timestamp,
          });

          if (latestTimeoutSeqNum == undefined) {
            latestTimeoutSeqNum = sequenceNumber;
          }
          // 現在のSeqNumとの差が最も大きいSeqNumを探す
          if (
            uint16Add(sequenceNumber, -this.presentSeqNum!) >
            uint16Add(latestTimeoutSeqNum, -this.presentSeqNum!)
          ) {
            latestTimeoutSeqNum = sequenceNumber;
          }

          const packet = this.rtpBuffer[sequenceNumber];
          delete this.rtpBuffer[sequenceNumber];
          return packet;
        }
      })
      .flatMap((p): RtpPacket => p as RtpPacket)
      .filter((p) => p);

    const sorted = this.sortAndClearBuffer(
      packets.reduce((acc, cur) => {
        acc[cur.header.sequenceNumber] = cur;
        return acc;
      }, {})
    );

    return { latestTimeoutSeqNum, sorted };
  }
}

export interface JitterBufferOptions {
  /**milliseconds */
  latency: number;
  bufferSize: number;
}
