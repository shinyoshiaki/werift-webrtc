import {
  type RtpPacket,
  uint16Add,
  uint16Gte,
  uint32Add,
  uint32Gt,
} from "../..";
import type { Processor } from "./interface";
import type { RtpOutput } from "./rtpCallback";

export type JitterBufferInput = RtpOutput;

export interface JitterBufferOutput extends RtpOutput {
  isPacketLost?: { from: number; to: number };
}

/**
 * Reorders RTP packets by sequence number.
 *
 * Invariants:
 * - every packet that is delayed by less than `latency` (measured by RTP
 *   timestamps of later arrivals) is output exactly once, in sequence order
 * - only sequence numbers that were never received are given up; each given
 *   up range is reported once with `isPacketLost` (`to` is the last missing
 *   sequence number) right before the packet that follows it
 * - the output position only moves past a missing sequence number when a
 *   later packet has timed out, the buffer is full, or at eol
 * - packets at or before the output position (duplicates, or packets whose
 *   loss was already given up) are dropped
 * - sequence numbers and timestamps are compared with uint16 / uint32
 *   wraparound
 */
export class JitterBufferBase
  implements Processor<JitterBufferInput, JitterBufferOutput>
{
  private options: JitterBufferOptions;
  /**uint16. sequence number of the last output packet */
  private presentSeqNum?: number;
  private rtpBuffer: { [sequenceNumber: number]: RtpPacket } = {};
  private get expectNextSeqNum() {
    return uint16Add(this.presentSeqNum!, 1);
  }
  private internalStats = {};

  constructor(
    public clockRate: number,
    options: Partial<JitterBufferOptions> = {},
  ) {
    this.options = {
      latency: options.latency ?? 200,
      bufferSize: options.bufferSize ?? 10000,
    };
  }

  toJSON() {
    return {
      ...this.internalStats,
      rtpBufferLength: Object.values(this.rtpBuffer).length,
      presentSeqNum: this.presentSeqNum,
      expectNextSeqNum: this.expectNextSeqNum,
    };
  }

  private stop() {
    this.rtpBuffer = {};
  }

  processInput(input: JitterBufferInput): JitterBufferOutput[] {
    const output: JitterBufferOutput[] = [];

    if (!input.rtp) {
      if (input.eol) {
        const buffered = this.sortedBuffer();
        if (buffered.length > 0) {
          this.releaseUntil(buffered.at(-1)!.header.sequenceNumber, output);
        }
        output.push({ eol: true });

        this.stop();
      }
      return output;
    }

    const rtp = input.rtp;
    const { sequenceNumber, timestamp } = rtp.header;

    // init
    if (this.presentSeqNum == undefined) {
      this.presentSeqNum = sequenceNumber;
      output.push({ rtp });
      this.internalStats["jitterBuffer"] = new Date().toISOString();
      return output;
    }

    // duplicate, or a packet whose loss was already given up
    if (
      uint16Gte(this.presentSeqNum, sequenceNumber) ||
      this.rtpBuffer[sequenceNumber]
    ) {
      this.internalStats["duplicate"] = {
        count: (this.internalStats["duplicate"]?.count ?? 0) + 1,
        sequenceNumber,
        timestamp: new Date().toISOString(),
      };
      return [];
    }

    this.rtpBuffer[sequenceNumber] = rtp;
    this.releaseContinuous(output);

    const timeoutSeqNum = this.findLatestTimeoutSeqNum(timestamp);
    if (timeoutSeqNum != undefined) {
      this.releaseUntil(timeoutSeqNum, output);
    }

    const buffered = this.sortedBuffer();
    if (buffered.length > this.options.bufferSize) {
      this.internalStats["buffer_overflow"] = {
        count: (this.internalStats["buffer_overflow"]?.count ?? 0) + 1,
        timestamp: new Date().toISOString(),
      };
      const overflowSeqNum =
        buffered[buffered.length - this.options.bufferSize - 1].header
          .sequenceNumber;
      this.releaseUntil(overflowSeqNum, output);
    }

    if (output.length > 0) {
      this.internalStats["jitterBuffer"] = new Date().toISOString();
    }
    return output;
  }

  /**distance from the output position. 1 is the next expected packet */
  private distance(sequenceNumber: number) {
    return uint16Add(sequenceNumber, -this.presentSeqNum!);
  }

  private sortedBuffer() {
    return Object.values(this.rtpBuffer).sort(
      (a, b) =>
        this.distance(a.header.sequenceNumber) -
        this.distance(b.header.sequenceNumber),
    );
  }

  /**output buffered packets that continue from the output position */
  private releaseContinuous(output: JitterBufferOutput[]) {
    for (;;) {
      const next = this.expectNextSeqNum;
      const rtp = this.rtpBuffer[next];
      if (!rtp) {
        return;
      }
      delete this.rtpBuffer[next];
      this.presentSeqNum = next;
      output.push({ rtp });
    }
  }

  /**
   * give up the missing sequence numbers up to `sequenceNumber`, output the
   * buffered packets up to it in order, then the packets continuing from it
   */
  private releaseUntil(sequenceNumber: number, output: JitterBufferOutput[]) {
    const base = this.presentSeqNum!;
    const limit = uint16Add(sequenceNumber, -base);
    for (const rtp of this.sortedBuffer()) {
      const seq = rtp.header.sequenceNumber;
      if (uint16Add(seq, -base) > limit) {
        break;
      }
      if (seq !== this.expectNextSeqNum) {
        output.push({
          isPacketLost: { from: this.expectNextSeqNum, to: uint16Add(seq, -1) },
        });
      }
      delete this.rtpBuffer[seq];
      this.presentSeqNum = seq;
      output.push({ rtp });
    }
    this.releaseContinuous(output);
  }

  /**the furthest buffered packet that has waited longer than latency */
  private findLatestTimeoutSeqNum(baseTimestamp: number) {
    let latestTimeoutSeqNum: number | undefined;

    for (const rtp of Object.values(this.rtpBuffer)) {
      const { timestamp, sequenceNumber } = rtp.header;

      if (uint32Gt(timestamp, baseTimestamp)) {
        continue;
      }

      const elapsedSec = uint32Add(baseTimestamp, -timestamp) / this.clockRate;
      if (elapsedSec * 1000 <= this.options.latency) {
        continue;
      }

      this.internalStats["timeout_packet"] = {
        count: (this.internalStats["timeout_packet"]?.count ?? 0) + 1,
        at: new Date().toISOString(),
        sequenceNumber,
        elapsedSec,
        baseTimestamp,
        timestamp,
      };
      if (
        latestTimeoutSeqNum == undefined ||
        this.distance(sequenceNumber) > this.distance(latestTimeoutSeqNum)
      ) {
        latestTimeoutSeqNum = sequenceNumber;
      }
    }

    return latestTimeoutSeqNum;
  }
}

export interface JitterBufferOptions {
  /**milliseconds */
  latency: number;
  bufferSize: number;
}
