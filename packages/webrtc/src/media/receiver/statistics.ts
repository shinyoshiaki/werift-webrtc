import { int, uint16Gt } from '../../../../common/src';
import { RtpPacket } from '../../../../rtp/src';

// from aiortc

export class StreamStatistics {
  base_seq?: number;
  max_seq?: number;
  cycles = 0;
  packets_received = 0;

  // # jitter
  private clockRate: number;
  jitter_q4 = 0;
  private last_arrival?: number;
  private last_timestamp?: number;

  // # fraction lost
  expected_prior = 0;
  received_prior = 0;

  constructor(clockRate: number) {
    this.clockRate = clockRate;
  }

  add(packet: RtpPacket, now: number = Date.now() / 1000) {
    const inOrder =
      this.max_seq == undefined || uint16Gt(packet.header.sequenceNumber, this.max_seq);
    this.packets_received++;

    if (this.base_seq == undefined) {
      this.base_seq = packet.header.sequenceNumber;
    }

    if (inOrder) {
      const arrival = int(now * this.clockRate);

      if (this.max_seq != undefined && packet.header.sequenceNumber < this.max_seq) {
        this.cycles += 1 << 16;
      }
      this.max_seq = packet.header.sequenceNumber;

      if (packet.header.timestamp !== this.last_timestamp && this.packets_received > 1) {
        const diff = Math.abs(
          arrival -
            (this.last_arrival ?? 0) -
            (packet.header.timestamp - (this.last_timestamp ?? 0))
        );
        this.jitter_q4 += diff - ((this.jitter_q4 + 8) >> 4);
      }

      this.last_arrival = arrival;
      this.last_timestamp = packet.header.timestamp;
    }
  }

  get fraction_lost() {
    const expected_interval = this.packets_expected - this.expected_prior;
    this.expected_prior = this.packets_expected;
    const received_interval = this.packets_received - this.received_prior;
    this.received_prior = this.packets_received;
    const lost_interval = expected_interval - received_interval;
    if (expected_interval == 0 || lost_interval <= 0) {
      return 0;
    } else {
      return Math.floor((lost_interval << 8) / expected_interval);
    }
  }

  get jitter() {
    return this.jitter_q4 >> 4;
  }

  get packets_expected() {
    return this.cycles + (this.max_seq ?? 0) - (this.base_seq ?? 0) + 1;
  }

  get packets_lost() {
    const lost = this.packets_expected - this.packets_received;
    return lost < 0 ? 0 : lost;
  }
}
