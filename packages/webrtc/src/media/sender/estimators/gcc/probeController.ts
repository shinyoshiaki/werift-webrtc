import {
  kDefaultStartBitrateBps,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeBitrateMultipliers,
  kProbeCooldownMs,
  kProbeMinDurationMs,
  kProbeMinPackets,
} from "./constants";

export type ProbeState = "idle" | "probing" | "cooldown";

interface ProbeCluster {
  id: number;
  targetBps: number;
  startMs: number;
  bytes: number;
  packets: number;
  firstRecvMs: number;
  lastRecvMs: number;
}

/**
 * Lightweight probe bitrate controller / estimator (libwebrtc ProbeController intent).
 *
 * Schedules exploratory target bitrates at startup / after recovery and estimates
 * capacity from TWCC-acked probe (probation) packets when available.
 *
 * Known difference: does not own a pacer; `suggestedProbeBitrateBps` is advisory
 * for applications that can raise send rate temporarily.
 */
export class ProbeController {
  private state: ProbeState = "idle";
  private nextClusterId = 1;
  private activeCluster?: ProbeCluster;
  private lastProbeCompleteMs = 0;
  private estimatedBps = 0;
  /** One-shot result ready to be consumed by the parent estimator. */
  private pendingEstimateBps = 0;
  private started = false;

  reset() {
    this.state = "idle";
    this.nextClusterId = 1;
    this.activeCluster = undefined;
    this.lastProbeCompleteMs = 0;
    this.estimatedBps = 0;
    this.pendingEstimateBps = 0;
    this.started = false;
  }

  get probeState(): ProbeState {
    return this.state;
  }

  /** Last successful probe bitrate estimate (0 if none). */
  get estimatedBitrateBps() {
    return this.estimatedBps;
  }

  /**
   * Consume a newly completed probe estimate (0 if none pending).
   * Ensures a probe result is applied at most once by the parent controller.
   */
  takePendingEstimateBps(): number {
    const v = this.pendingEstimateBps;
    this.pendingEstimateBps = 0;
    return v;
  }

  /**
   * Suggested exploratory bitrate for the application / sender (0 if not probing).
   */
  get suggestedProbeBitrateBps() {
    return this.activeCluster?.targetBps ?? 0;
  }

  /**
   * Possibly start a probe cluster based on current target and wall time.
   */
  maybeStartProbe(currentTargetBps: number, nowMs: number): number | undefined {
    if (this.state === "probing") {
      return this.activeCluster?.targetBps;
    }
    if (
      this.state === "cooldown" &&
      nowMs - this.lastProbeCompleteMs < kProbeCooldownMs
    ) {
      return undefined;
    }

    const base = Math.max(currentTargetBps, kDefaultStartBitrateBps);
    // First probes after start: aggressive multiples; later: modest recovery probe.
    const mult = this.started
      ? 1.5
      : kProbeBitrateMultipliers[Math.min(this.nextClusterId - 1, 1)];
    this.started = true;

    const targetBps = clamp(base * mult);
    this.activeCluster = {
      id: this.nextClusterId++,
      targetBps,
      startMs: nowMs,
      bytes: 0,
      packets: 0,
      firstRecvMs: 0,
      lastRecvMs: 0,
    };
    this.state = "probing";
    return targetBps;
  }

  /**
   * Feed an acked packet that may belong to the active probe cluster.
   * Prefer packets marked isProbation; also accept any packet while probing.
   */
  onAckedPacket(sizeBytes: number, receivedAtMs: number, isProbe: boolean) {
    const cluster = this.activeCluster;
    if (!cluster || this.state !== "probing") return;
    if (!isProbe && cluster.packets === 0) {
      // Wait for at least one explicit probe packet when available.
      // If sender never marks probation, still accumulate after start.
    }

    cluster.bytes += sizeBytes;
    cluster.packets += 1;
    if (cluster.firstRecvMs === 0) cluster.firstRecvMs = receivedAtMs;
    cluster.lastRecvMs = receivedAtMs;

    const durationMs = cluster.lastRecvMs - cluster.firstRecvMs;
    if (
      cluster.packets >= kProbeMinPackets &&
      durationMs >= kProbeMinDurationMs
    ) {
      const bps = (cluster.bytes * 8 * 1000) / Math.max(durationMs, 1);
      this.estimatedBps = clamp(bps);
      this.pendingEstimateBps = this.estimatedBps;
      this.lastProbeCompleteMs = receivedAtMs;
      this.activeCluster = undefined;
      this.state = "cooldown";
    }
  }

  /** Force-finish probe without a result (e.g. timeout). */
  abort(nowMs: number) {
    if (this.state === "probing") {
      this.activeCluster = undefined;
      this.state = "cooldown";
      this.lastProbeCompleteMs = nowMs;
    }
  }
}

function clamp(bps: number) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), kMaxBitrateBps);
}
