import type { BurstPacketLoss, DebugConfig } from "../api/peerConfig";

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

  dropInboundRtp() {
    return this.inboundBurst.drop(this.config.debug?.inboundBurstLoss);
  }

  dropOutboundRtp() {
    return this.outboundBurst.drop(this.config.debug?.outboundBurstLoss);
  }
}
