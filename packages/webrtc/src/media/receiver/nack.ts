import { Event, uint16Add } from "../../imports/common";
import {
  debug,
  GenericNack,
  RtcpTransportLayerFeedback,
  type RtpPacket,
} from "../../imports/rtp";
import type { RTCRtpReceiver } from "../rtpReceiver";

const log = debug("werift:packages/webrtc/src/media/receiver/nack.ts");

const LOST_SIZE = 30 * 5;
/**
 * Media SSRCs with NACK state at once. A receiver has a few live SSRCs (one
 * per simulcast layer); a sender that keeps changing SSRCs must not grow the
 * state for the receiver's lifetime, so the least recently received SSRC is
 * dropped (its timer stopped) beyond this. Its next packet starts afresh.
 */
export const MAX_NACK_STREAMS = 16;

/**
 * Generic NACK (RFC 4585 section 6.2.1) for the media SSRCs of one receiver.
 * Loss detection and retransmission requests are kept per media SSRC, so the
 * layers of a simulcast receiver (one SSRC each) never compare their sequence
 * numbers with each other and each NACK names the SSRC that lost the packets.
 * At most {@link MAX_NACK_STREAMS} SSRCs keep state (least recently received
 * evicted first).
 */
export class NackHandler {
  private readonly receiver: RTCRtpReceiver;
  private readonly streams = new Map<number, NackStream>();

  readonly onPacketLost = new Event<[GenericNack]>();
  /** Media SSRC of the latest packet. */
  mediaSourceSsrc?: number;
  retryCount = 10;
  closed = false;

  constructor(receiver: RTCRtpReceiver) {
    this.receiver = receiver;
  }

  /** Lost sequence numbers of the latest media SSRC. */
  get lostSeqNumbers() {
    return this.mediaSourceSsrc === undefined
      ? []
      : this.lostSeqNumbersOf(this.mediaSourceSsrc);
  }

  lostSeqNumbersOf(ssrc: number) {
    return this.streams.get(ssrc)?.lostSeqNumbers ?? [];
  }

  /** Media SSRCs with NACK state. */
  get ssrcs() {
    return [...this.streams.keys()];
  }

  /** `packet` is a media packet (RTX already restored to its media SSRC). */
  addPacket(packet: RtpPacket) {
    const { ssrc } = packet.header;
    this.mediaSourceSsrc = ssrc;
    if (this.closed) return;

    let stream = this.streams.get(ssrc);
    if (stream) {
      // Map の挿入順を受信順に保ち、先頭を最も古い SSRC にする。
      this.streams.delete(ssrc);
    } else {
      stream = new NackStream(ssrc, this);
    }
    this.streams.set(ssrc, stream);
    if (this.streams.size > MAX_NACK_STREAMS) {
      const [oldest, evicted] = this.streams.entries().next().value!;
      evicted.close();
      this.streams.delete(oldest);
    }
    stream.addPacket(packet.header.sequenceNumber);
  }

  close() {
    this.closed = true;
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
  }

  /** Internal: send one NACK for `ssrc` and notify {@link onPacketLost}. */
  async sendNack(ssrc: number, lost: number[]) {
    const nack = new GenericNack({
      senderSsrc: this.receiver.rtcpSsrc,
      mediaSourceSsrc: ssrc,
      lost,
    });
    const rtcp = new RtcpTransportLayerFeedback({ feedback: nack });
    const sent = this.receiver.dtlsTransport.sendRtcp([rtcp]);
    this.onPacketLost.execute(nack);
    await sent;
  }
}

/** Loss state of one media SSRC. */
class NackStream {
  private newEstSeqNum?: number;
  private lost: { [seqNum: number]: number } = {};
  private nackLoop?: ReturnType<typeof setInterval>;
  private readonly ssrc: number;
  private readonly handler: NackHandler;

  constructor(ssrc: number, handler: NackHandler) {
    this.ssrc = ssrc;
    this.handler = handler;
  }

  get lostSeqNumbers() {
    return Object.keys(this.lost)
      .map(Number)
      .sort((a, b) => a - b);
  }

  addPacket(sequenceNumber: number) {
    if (this.newEstSeqNum === undefined) {
      this.newEstSeqNum = sequenceNumber;
      return;
    }

    if (this.lost[sequenceNumber]) {
      delete this.lost[sequenceNumber];
      return;
    }

    if (sequenceNumber === uint16Add(this.newEstSeqNum, 1)) {
      this.newEstSeqNum = sequenceNumber;
    } else if (sequenceNumber > uint16Add(this.newEstSeqNum, 1)) {
      // packet lost detected
      for (
        let i = uint16Add(this.newEstSeqNum, 1);
        i < sequenceNumber;
        i = uint16Add(i, 1)
      ) {
        this.setLost(i, 1);
      }

      this.newEstSeqNum = sequenceNumber;
      this.pruneLost();
    }
  }

  private setLost(seq: number, count: number) {
    this.lost[seq] = count;

    if (this.nackLoop) {
      return;
    }
    this.nackLoop = setInterval(async () => {
      try {
        await this.sendNack();
      } catch (error) {
        log("failed to send nack", error);
      }
    }, 5);
  }

  private pruneLost() {
    const lost = this.lostSeqNumbers;
    if (lost.length > LOST_SIZE) {
      for (const seq of lost.slice(0, lost.length - LOST_SIZE)) {
        delete this.lost[seq];
      }
    }
  }

  close() {
    this.stopLoop();
    this.lost = {};
  }

  private stopLoop() {
    clearInterval(this.nackLoop);
    this.nackLoop = undefined;
  }

  private updateRetryCount() {
    for (const seq of this.lostSeqNumbers) {
      const count = this.lost[seq]++;
      if (count > this.handler.retryCount) {
        delete this.lost[seq];
      }
    }
  }

  private async sendNack() {
    const lost = this.lostSeqNumbers;
    if (lost.length === 0) {
      this.stopLoop();
      return;
    }
    this.updateRetryCount();
    await this.handler.sendNack(this.ssrc, lost);
  }
}
