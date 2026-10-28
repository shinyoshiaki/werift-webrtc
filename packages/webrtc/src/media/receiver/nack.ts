import { Event, uint16Add, uint16Gt } from "../../imports/common";
import {
  debug,
  GenericNack,
  RtcpTransportLayerFeedback,
  type RtpPacket,
} from "../../imports/rtp";
import type { RTCRtpReceiver } from "../rtpReceiver";

const log = debug("werift:packages/webrtc/src/media/receiver/nack.ts");

const DEFAULT_MAX_LOST = 30 * 5;
const DEFAULT_RETRY_INTERVAL_MS = 5;
const DEFAULT_RETRY_COUNT = 10;

/**
 * Retry policy of the receiver-side generic NACK (RFC 4585).
 *
 * The default (`{}`) keeps the legacy behavior: a lost packet is NACKed every
 * 5ms and given up after 10 NACKs (about 50ms).
 */
export type NackOptions = {
  /**
   * Latency budget in ms. A lost packet is NACKed until this much time has
   * passed since its loss was detected, then given up.
   * `0` disables NACK. When undefined, `retryCount` decides when to give up.
   */
  maxWaitMs?: number;
  /** Interval in ms between NACKs for the same lost packet. Default 5. */
  retryIntervalMs?: number;
  /** NACKs per lost packet before giving up when `maxWaitMs` is undefined. Default 10. */
  retryCount?: number;
  /** Max lost packets tracked at the same time. Oldest are dropped. Default 150. */
  maxLost?: number;
};

/** Counters of the receiver-side NACK. */
export type NackStats = {
  /** Packets detected as missing. */
  lost: number;
  /** Missing packets that arrived (retransmitted or reordered) before giving up. */
  recovered: number;
  /** Missing packets given up because the budget or retry count ran out. */
  unrecovered: number;
  /** Missing packets still waiting for a retransmission. */
  pending: number;
};

type LostEntry = {
  detectedAt: number;
  lastNackAt?: number;
  /** NACKs sent for this packet */
  count: number;
};

export class NackHandler {
  private newEstSeqNum?: number;
  private readonly lost = new Map<number, LostEntry>();
  private nackLoop: any;
  private options: NackOptions = {};
  private counters = { lost: 0, recovered: 0, unrecovered: 0 };

  readonly onPacketLost = new Event<[GenericNack]>();
  mediaSourceSsrc?: number;
  closed = false;

  constructor(
    private receiver: RTCRtpReceiver,
    options: NackOptions = {},
  ) {
    this.setOptions(options);
  }

  get retryCount() {
    return this.options.retryCount ?? DEFAULT_RETRY_COUNT;
  }

  set retryCount(value: number) {
    this.options = { ...this.options, retryCount: value };
  }

  get maxWaitMs() {
    return this.options.maxWaitMs;
  }

  private get retryIntervalMs() {
    return Math.max(
      1,
      this.options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    );
  }

  private get maxLost() {
    return this.options.maxLost ?? DEFAULT_MAX_LOST;
  }

  /** Change the retry policy. Packets already lost follow the new policy. */
  setOptions(options: NackOptions) {
    this.options = { ...options };
    if (this.nackLoop) {
      clearInterval(this.nackLoop);
      this.nackLoop = undefined;
      this.startLoop();
    }
  }

  get stats(): NackStats {
    return { ...this.counters, pending: this.lost.size };
  }

  /** Lost sequence numbers in detection order (keeps 16bit wrap order). */
  get lostSeqNumbers() {
    return [...this.lost.keys()];
  }

  private setLost(seq: number, now: number) {
    this.counters.lost++;
    if (this.maxWaitMs === 0) {
      this.counters.unrecovered++;
      return;
    }
    this.lost.set(seq, { detectedAt: now, count: 0 });
    this.startLoop();
  }

  private startLoop() {
    if (this.nackLoop || this.closed || this.lost.size === 0) {
      return;
    }
    this.nackLoop = setInterval(() => {
      this.sendNack().catch((error) => log("failed to send nack", error));
      if (this.lost.size === 0) {
        clearInterval(this.nackLoop);
        this.nackLoop = undefined;
      }
    }, this.retryIntervalMs);
  }

  addPacket(packet: RtpPacket) {
    const { sequenceNumber, ssrc } = packet.header;
    this.mediaSourceSsrc = ssrc;

    if (this.newEstSeqNum === undefined) {
      this.newEstSeqNum = sequenceNumber;
      return;
    }

    if (this.lost.has(sequenceNumber)) {
      this.lost.delete(sequenceNumber);
      this.counters.recovered++;
      return;
    }

    if (sequenceNumber === uint16Add(this.newEstSeqNum, 1)) {
      this.newEstSeqNum = sequenceNumber;
    } else if (uint16Gt(sequenceNumber, uint16Add(this.newEstSeqNum, 1))) {
      // packet lost detected
      const now = Date.now();
      for (
        let i = uint16Add(this.newEstSeqNum, 1);
        i !== sequenceNumber;
        i = uint16Add(i, 1)
      ) {
        this.setLost(i, now);
      }

      this.newEstSeqNum = sequenceNumber;
      this.pruneLost();
    }
  }

  private pruneLost() {
    // Map keeps insertion order, so the first keys are the oldest losses.
    for (const seq of this.lost.keys()) {
      if (this.lost.size <= this.maxLost) {
        break;
      }
      this.lost.delete(seq);
      this.counters.unrecovered++;
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.nackLoop);
    this.nackLoop = undefined;
    this.lost.clear();
  }

  /** Remove packets whose budget or retry count ran out. */
  private giveUpExpired(now: number) {
    for (const [seq, entry] of this.lost) {
      const expired =
        this.maxWaitMs !== undefined
          ? now - entry.detectedAt >= this.maxWaitMs
          : entry.count >= this.retryCount + 1;
      if (expired) {
        this.lost.delete(seq);
        this.counters.unrecovered++;
      }
    }
  }

  private async sendNack() {
    const now = Date.now();
    this.giveUpExpired(now);
    if (this.lost.size === 0 || !this.mediaSourceSsrc) {
      return;
    }

    const lost: number[] = [];
    for (const [seq, entry] of this.lost) {
      if (
        entry.lastNackAt === undefined ||
        now - entry.lastNackAt >= this.retryIntervalMs
      ) {
        entry.lastNackAt = now;
        entry.count++;
        lost.push(seq);
      }
    }
    if (lost.length === 0) {
      return;
    }

    const nack = new GenericNack({
      senderSsrc: this.receiver.rtcpSsrc,
      mediaSourceSsrc: this.mediaSourceSsrc,
      lost,
    });
    const rtcp = new RtcpTransportLayerFeedback({
      feedback: nack,
    });
    this.onPacketLost.execute(nack);
    await this.receiver.dtlsTransport.sendRtcp([rtcp]);
  }
}
