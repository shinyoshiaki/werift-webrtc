import { Event } from "../../imports/common";
import {
  debug,
  GenericNack,
  RtcpTransportLayerFeedback,
  type RtpPacket,
} from "../../imports/rtp";
import type { RTCRtpReceiver } from "../rtpReceiver";

const log = debug("werift:packages/webrtc/src/media/receiver/nack.ts");

/** Holes NACK asks for at once (the newest ones). */
const LOST_SIZE = 30 * 5;
/**
 * Holes kept per media SSRC for RTX verification. At least {@link LOST_SIZE},
 * so every requested hole is kept; holes past NACK's retries stay
 * verifiable until this bound, for an RTX that answers an earlier NACK late.
 */
export const MAX_HOLES = 1024;
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
    stream.addPacket(packet.header.sequenceNumber, packet.header.timestamp);
  }

  /**
   * Whether an RTX packet restoring `sequenceNumber` / `timestamp` on `ssrc`
   * fills a hole this handler detected: its number is a hole of `ssrc` (NACK
   * asks for it, or asked and still keeps it) and its timestamp lies within
   * the timestamps of the packets received around the gap, in either order
   * (frames sent out of display order) and widened by `slack`.
   */
  canRepair(
    ssrc: number,
    sequenceNumber: number,
    timestamp: number,
    slack: number,
  ) {
    return (
      this.streams.get(ssrc)?.canRepair(sequenceNumber, timestamp, slack) ??
      false
    );
  }

  /** Reset `ssrc`: its NACK requests and holes end together. */
  forget(ssrc: number) {
    this.streams.get(ssrc)?.close();
    this.streams.delete(ssrc);
  }

  /** Holes kept for `ssrc` (requested or not). */
  holeCountOf(ssrc: number) {
    return this.streams.get(ssrc)?.holeCount ?? 0;
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

/** A missing packet of a media SSRC, from the moment NACK detected it. */
interface Hole {
  sequenceNumber: number;
  /** Timestamps of the received packets before and after the gap. */
  timestampBefore: number;
  timestampAfter: number;
  /** NACKs sent for it, or `undefined` once NACK stopped asking for it. */
  requests?: number;
}

/**
 * Loss state of one media SSRC: one ledger of holes serves both NACK (the
 * holes still requested) and RTX verification (every hole kept, see
 * {@link NackHandler.canRepair}). A hole leaves the ledger only when its
 * packet arrives, when it falls out of the bounds below, or when the stream
 * is reset; NACK stops asking for it at that moment at the latest, so a
 * requested packet can always be verified when its RTX arrives.
 */
class NackStream {
  /** Extended (wrap-counting) sequence number and timestamp of the newest packet. */
  private newestExt?: number;
  private newestTimestamp = 0;
  /** Holes by extended sequence number, oldest first (insertion order). */
  private readonly holes = new Map<number, Hole>();
  private nackLoop?: ReturnType<typeof setInterval>;
  private readonly ssrc: number;
  private readonly handler: NackHandler;

  constructor(ssrc: number, handler: NackHandler) {
    this.ssrc = ssrc;
    this.handler = handler;
  }

  /** Sequence numbers NACK still asks for, oldest first. */
  get lostSeqNumbers() {
    const lost: number[] = [];
    for (const hole of this.holes.values()) {
      if (hole.requests !== undefined) lost.push(hole.sequenceNumber);
    }
    return lost;
  }

  get holeCount() {
    return this.holes.size;
  }

  addPacket(sequenceNumber: number, timestamp: number) {
    if (this.newestExt === undefined) {
      this.newestExt = sequenceNumber;
      this.newestTimestamp = timestamp;
      return;
    }
    const ext = this.extend(sequenceNumber);
    if (ext <= this.newestExt) {
      // 遅着・再送で欠落が埋まった。台帳にない番号は重複か要求外なので何もしない。
      this.holes.delete(ext);
      if (this.holes.size === 0) this.stopLoop();
      return;
    }

    // 新しい欠落: 台帳に入るのは末尾 MAX_HOLES 個まで (それ以前は要求も検証もしない)。
    const from = Math.max(this.newestExt + 1, ext - MAX_HOLES);
    for (let missing = from; missing < ext; missing++) {
      this.holes.set(missing, {
        sequenceNumber: missing & 0xffff,
        timestampBefore: this.newestTimestamp,
        timestampAfter: timestamp,
        requests: 0,
      });
    }
    this.newestExt = ext;
    this.newestTimestamp = timestamp;
    this.pruneHoles();
    if (from < ext) this.startLoop();
  }

  /** Whether an RTX packet with this original number and timestamp fills a hole. */
  canRepair(sequenceNumber: number, timestamp: number, slack: number) {
    if (this.newestExt === undefined) return false;
    const hole = this.holes.get(this.extend(sequenceNumber));
    if (!hole) return false;
    // 時刻は欠落直後の受信パケットからの符号付き差で比べる (32 bit の折り返しに依存しない)。
    const before = (hole.timestampBefore - hole.timestampAfter) | 0;
    const offset = (timestamp - hole.timestampAfter) | 0;
    return (
      offset >= Math.min(before, 0) - slack &&
      offset <= Math.max(before, 0) + slack
    );
  }

  /**
   * Bounds of the ledger. Each removal removes the hole itself, so NACK stops
   * asking for it at the same moment; NACK's own limits (LOST_SIZE requests,
   * `retryCount`) only stop the request and keep the hole verifiable.
   */
  private pruneHoles() {
    const newest = this.newestExt!;
    for (const [ext] of this.holes) {
      // 16 bit の番号は 0x8000 以上離れると前後を区別できない。
      if (this.holes.size <= MAX_HOLES && newest - ext < 0x8000) break;
      this.holes.delete(ext);
    }
    let requested = 0;
    const holes = [...this.holes.values()];
    for (let i = holes.length - 1; i >= 0; i--) {
      if (holes[i].requests === undefined) continue;
      if (++requested > LOST_SIZE) holes[i].requests = undefined;
    }
  }

  /** `sequenceNumber` as the extended number nearest the newest. */
  private extend(sequenceNumber: number) {
    const newest = this.newestExt!;
    const delta = (sequenceNumber - newest) & 0xffff;
    return newest + (delta < 0x8000 ? delta : delta - 0x10000);
  }

  private startLoop() {
    if (this.nackLoop) return;
    this.nackLoop = setInterval(async () => {
      try {
        await this.sendNack();
      } catch (error) {
        log("failed to send nack", error);
      }
    }, 5);
  }

  close() {
    this.stopLoop();
    this.holes.clear();
  }

  private stopLoop() {
    clearInterval(this.nackLoop);
    this.nackLoop = undefined;
  }

  private async sendNack() {
    const lost = this.lostSeqNumbers;
    if (lost.length === 0) {
      this.stopLoop();
      return;
    }
    for (const hole of this.holes.values()) {
      if (hole.requests === undefined) continue;
      if (++hole.requests > this.handler.retryCount) hole.requests = undefined;
    }
    await this.handler.sendNack(this.ssrc, lost);
  }
}
