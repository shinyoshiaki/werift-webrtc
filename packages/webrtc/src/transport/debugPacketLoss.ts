import type {
  BurstPacketLoss,
  DebugConfig,
  DebugRtpHeader,
} from "../api/peerConfig";

/** RTP header fields of an (S)RTP packet; the header is not encrypted. */
export function debugRtpHeader(data: Buffer): DebugRtpHeader {
  return {
    sequenceNumber: data.readUInt16BE(2),
    timestamp: data.readUInt32BE(4),
    ssrc: data.readUInt32BE(8),
  };
}

/** `true` with probability `percent`% (DebugConfig.*PacketLoss). */
export function dropByPercent(
  percent: number | undefined,
  random: () => number = Math.random,
) {
  return !!percent && random() < percent / 100;
}

/**
 * Periodic burst loss of DebugConfig. The clock starts at the first RTP
 * packet checked, so the drop windows are the same for every run.
 */
export class BurstLossClock {
  private startedAt?: number;

  drop(burst: BurstPacketLoss | undefined, now = Date.now()) {
    if (!burst || !(burst.intervalMs > 0) || !(burst.durationMs > 0)) {
      return false;
    }
    if (this.startedAt === undefined) {
      this.startedAt = now;
    }
    const offset = burst.offsetMs ?? burst.intervalMs - burst.durationMs;
    const elapsed = now - this.startedAt - offset;
    if (elapsed < 0) {
      return false;
    }
    return elapsed % burst.intervalMs < burst.durationMs;
  }
}

export class DebugPacketLoss {
  private readonly inboundBurst = new BurstLossClock();
  private readonly outboundBurst = new BurstLossClock();

  constructor(private readonly config: { debug?: DebugConfig }) {}

  dropInbound() {
    return dropByPercent(this.config.debug?.inboundPacketLoss);
  }

  dropOutbound() {
    return dropByPercent(this.config.debug?.outboundPacketLoss);
  }

  dropInboundRtp(data: Buffer) {
    // Both see every packet: the predicate can tell a first transmission from
    // a retransmission, and the burst clock starts at the first packet.
    const drop = this.config.debug?.inboundRtpDrop;
    const dropped = !!drop && data.length >= 12 && drop(debugRtpHeader(data));
    const burst = this.inboundBurst.drop(this.config.debug?.inboundBurstLoss);
    return dropped || burst;
  }

  dropOutboundRtp() {
    return this.outboundBurst.drop(this.config.debug?.outboundBurstLoss);
  }
}
