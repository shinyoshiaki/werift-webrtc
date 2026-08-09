import {
  kDefaultStartBitrateBps,
  kFurtherProbeStepMultiplier,
  kFurtherProbeThreshold,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeBitrateMultipliers,
  kProbeMinDurationMs,
  kProbeMinIntervalMs,
  kProbeMinPackets,
  kProbeMinReceivedBytesPercent,
  kProbeMinReceivedProbesPercent,
  kProbeMaxValidRatio,
  kProbeMinRatioForUnsaturated,
  kProbeTargetUtilization,
  kProbeMaxIntervalMs,
  kProbeRecoveryMaxScale,
  kProbeRecoveryScale,
  kProbeResultTimeoutMs,
} from "./constants";

/**
 * libwebrtc ProbeController-aligned states:
 * - init: no probing initiated yet
 * - waiting_for_result: cluster(s) outstanding
 * - complete: initial exponential probing finished
 */
export type ProbeState = "init" | "waiting_for_result" | "complete";

export interface ProbeClusterConfig {
  id: number;
  /** Target bitrate the pacer / sender should temporarily aim for (bps). */
  targetBps: number;
  minPackets: number;
  minDurationMs: number;
  /** Minimum bytes expected for the cluster (for receive-ratio checks). */
  minBytes: number;
}

/**
 * Per-cluster stats for libwebrtc ProbeBitrateEstimator-style validation.
 * Packets are assigned a cluster id at send time (wideSeq → clusterId map).
 */
interface ActiveCluster {
  config: ProbeClusterConfig;
  startMs: number;
  // Send-side
  sentBytes: number;
  sentPackets: number;
  firstSendMs: number;
  lastSendMs: number;
  sizeLastSend: number;
  // Receive / ACK side
  ackedBytes: number;
  ackedPackets: number;
  firstRecvMs: number;
  lastRecvMs: number;
  sizeFirstRecv: number;
}

/**
 * Probe controller (libwebrtc `ProbeController` + `ProbeBitrateEstimator`).
 *
 * - `setBitrates` / cold start → exponential probe clusters (×3 and ×6)
 * - **Multi-active**: initial 3x/6x can be active simultaneously
 * - Per-packet **cluster id** (via wideSeq map) — ACKs credit one cluster only
 * - Result validation: min receive %, send/recv intervals, send/recv rate ratio
 * - Recovery probes use current estimate + cooldown
 */
export class ProbeController {
  private state: ProbeState = "init";
  private nextClusterId = 1;
  private active: ActiveCluster[] = [];
  private queue: ProbeClusterConfig[] = [];
  private estimatedBps = 0;
  private pendingEstimateBps = 0;
  private lastProbeTargetBps = 0;
  private lastProbeEndMs = Number.NEGATIVE_INFINITY;
  private minBitrateBps = kMinBitrateBps;
  private startBitrateBps = kDefaultStartBitrateBps;
  private maxBitrateBps = kMaxBitrateBps;
  private networkAvailable = true;
  /** transport-wide seq → cluster id for probation packets. */
  private seqToCluster = new Map<number, number>();
  /** Cluster currently being filled with sent packets (round-robin among active). */
  private fillClusterId = 0;

  reset(_atTimeMs = 0) {
    this.state = "init";
    this.nextClusterId = 1;
    this.active = [];
    this.queue = [];
    this.estimatedBps = 0;
    this.pendingEstimateBps = 0;
    this.lastProbeTargetBps = 0;
    this.lastProbeEndMs = Number.NEGATIVE_INFINITY;
    this.minBitrateBps = kMinBitrateBps;
    this.startBitrateBps = kDefaultStartBitrateBps;
    this.maxBitrateBps = kMaxBitrateBps;
    this.networkAvailable = true;
    this.seqToCluster.clear();
    this.fillClusterId = 0;
  }

  get probeState(): ProbeState {
    return this.state;
  }

  get estimatedBitrateBps() {
    return this.estimatedBps;
  }

  get currentProbeTargetBps() {
    if (this.active.length === 0) return 0;
    return Math.max(...this.active.map((c) => c.config.targetBps));
  }

  get suggestedProbeBitrateBps() {
    return this.currentProbeTargetBps;
  }

  get activeClusterCount() {
    return this.active.length;
  }

  takePendingEstimateBps(): number {
    const v = this.pendingEstimateBps;
    this.pendingEstimateBps = 0;
    return v;
  }

  shouldTagProbePacket(): boolean {
    return this.active.length > 0;
  }

  /**
   * Bytes still needed across active clusters (for padding injection).
   */
  remainingProbeBytes(): number {
    let rem = 0;
    for (const c of this.active) {
      rem += Math.max(0, c.config.minBytes - c.sentBytes);
    }
    return rem;
  }

  setBitrates(
    minBps: number,
    startBps: number,
    maxBps: number,
    nowMs: number,
  ): ProbeClusterConfig[] {
    this.minBitrateBps = Math.max(minBps, kMinBitrateBps);
    this.startBitrateBps = Math.max(startBps, this.minBitrateBps);
    this.maxBitrateBps = Math.max(maxBps, this.startBitrateBps);
    if (this.state === "init" && this.networkAvailable) {
      return this.initiateExponentialProbing(nowMs);
    }
    return [];
  }

  requestProbe(estimatedBps: number, nowMs: number): ProbeClusterConfig[] {
    if (this.state === "waiting_for_result") return [];
    if (this.state === "init") return [];
    if (!this.cooldownElapsed(nowMs)) return [];

    const base = Math.max(estimatedBps, this.minBitrateBps);
    const uncapped = base * kProbeRecoveryScale;
    const capped = Math.min(uncapped, base * kProbeRecoveryMaxScale);
    const target = clamp(capped, this.maxBitrateBps);
    if (target <= base * 1.05) return [];
    return this.enqueueClusters(nowMs, [target], false);
  }

  setEstimatedBitrate(bitrateBps: number, nowMs: number): ProbeClusterConfig[] {
    if (!this.cooldownElapsed(nowMs) && this.state === "complete") {
      return [];
    }
    if (
      this.lastProbeTargetBps > 0 &&
      bitrateBps > this.lastProbeTargetBps * kFurtherProbeThreshold &&
      (this.state === "complete" || this.state === "waiting_for_result")
    ) {
      const next = clamp(
        Math.min(
          bitrateBps * kFurtherProbeStepMultiplier,
          bitrateBps * kProbeRecoveryMaxScale,
        ),
        this.maxBitrateBps,
      );
      return this.enqueueClusters(nowMs, [next], false);
    }
    return [];
  }

  process(nowMs: number): ProbeClusterConfig[] {
    const before = this.active.length;
    const remaining: ActiveCluster[] = [];
    for (const c of this.active) {
      if (nowMs - c.startMs > kProbeResultTimeoutMs) {
        this.dropClusterSeqs(c.config.id);
        continue;
      }
      remaining.push(c);
    }
    this.active = remaining;
    if (before > 0 && this.active.length === 0 && this.queue.length === 0) {
      this.lastProbeEndMs = nowMs;
      this.state = this.estimatedBps > 0 ? "complete" : "init";
    } else if (
      this.active.length === 0 &&
      this.queue.length === 0 &&
      this.state === "waiting_for_result"
    ) {
      this.lastProbeEndMs = nowMs;
      this.state = this.estimatedBps > 0 ? "complete" : "init";
    }
    return this.maybeActivateQueued(nowMs);
  }

  /**
   * Record a probation (probe-tagged) packet at send time.
   * Assigns the packet to one active cluster and stores wideSeq → clusterId.
   */
  onProbePacketSent(sizeBytes: number, sendMs: number, wideSeq: number): number {
    if (this.active.length === 0) return 0;
    const cluster = this.pickClusterToFill();
    if (!cluster) return 0;

    const seq = wideSeq & 0xffff;
    this.seqToCluster.set(seq, cluster.config.id);

    if (cluster.sentPackets === 0) {
      cluster.firstSendMs = sendMs;
    }
    cluster.lastSendMs = sendMs;
    cluster.sizeLastSend = sizeBytes;
    cluster.sentBytes += sizeBytes;
    cluster.sentPackets += 1;
    return cluster.config.id;
  }

  /**
   * ACK a packet. Only credits the cluster that owned the wideSeq at send.
   * Applies ProbeBitrateEstimator validation before accepting a result.
   */
  onAckedPacket(
    sizeBytes: number,
    receivedAtMs: number,
    isProbe: boolean,
    wideSeq?: number,
  ) {
    if (this.active.length === 0 || !isProbe) return;

    let cluster: ActiveCluster | undefined;
    if (wideSeq !== undefined) {
      const id = this.seqToCluster.get(wideSeq & 0xffff);
      if (id !== undefined) {
        cluster = this.active.find((c) => c.config.id === id);
      }
    }
    // Fallback: single active cluster without seq map (unit tests).
    if (!cluster && this.active.length === 1 && this.seqToCluster.size === 0) {
      cluster = this.active[0];
    }
    if (!cluster) return;

    if (cluster.ackedPackets === 0) {
      cluster.firstRecvMs = receivedAtMs;
      cluster.sizeFirstRecv = sizeBytes;
    }
    cluster.lastRecvMs = receivedAtMs;
    cluster.ackedBytes += sizeBytes;
    cluster.ackedPackets += 1;

    const estimate = this.estimateClusterBitrate(cluster);
    if (estimate === undefined) return;

    if (estimate > this.estimatedBps) {
      this.estimatedBps = estimate;
      this.pendingEstimateBps = Math.max(this.pendingEstimateBps, estimate);
    }
    this.lastProbeTargetBps = Math.max(
      this.lastProbeTargetBps,
      cluster.config.targetBps,
    );

    // Cluster complete — remove it.
    this.dropClusterSeqs(cluster.config.id);
    this.active = this.active.filter((c) => c.config.id !== cluster!.config.id);
    if (this.active.length === 0 && this.queue.length === 0) {
      this.state = "complete";
      this.lastProbeEndMs = receivedAtMs;
    }
  }

  abort(nowMs: number) {
    this.active = [];
    this.queue = [];
    this.seqToCluster.clear();
    if (this.state === "waiting_for_result") {
      this.state = this.estimatedBps > 0 ? "complete" : "init";
      this.lastProbeEndMs = nowMs;
    }
  }

  /**
   * libwebrtc ProbeBitrateEstimator::HandleProbeAndEstimateBitrate validation.
   * Returns bps estimate or undefined if not yet valid / failed.
   */
  private estimateClusterBitrate(c: ActiveCluster): number | undefined {
    const minProbes = Math.ceil(
      (c.config.minPackets * kProbeMinReceivedProbesPercent) / 100,
    );
    const minBytes = Math.ceil(
      (c.config.minBytes * kProbeMinReceivedBytesPercent) / 100,
    );
    if (c.ackedPackets < minProbes || c.ackedBytes < minBytes) {
      return undefined;
    }

    const sendIntervalMs = c.lastSendMs - c.firstSendMs;
    const recvIntervalMs = c.lastRecvMs - c.firstRecvMs;
    if (
      sendIntervalMs <= 0 ||
      sendIntervalMs > kProbeMaxIntervalMs ||
      recvIntervalMs <= 0 ||
      recvIntervalMs > kProbeMaxIntervalMs
    ) {
      return undefined;
    }

    // Exclude last sent / first received packet sizes (libwebrtc).
    const sendSize = Math.max(0, c.sentBytes - c.sizeLastSend);
    const recvSize = Math.max(0, c.ackedBytes - c.sizeFirstRecv);
    if (sendSize <= 0 || recvSize <= 0) return undefined;

    const sendBps = (sendSize * 8 * 1000) / sendIntervalMs;
    const recvBps = (recvSize * 8 * 1000) / recvIntervalMs;
    const ratio = recvBps / sendBps;
    if (ratio > kProbeMaxValidRatio) {
      return undefined;
    }

    let res = Math.min(sendBps, recvBps);
    if (recvBps < kProbeMinRatioForUnsaturated * sendBps) {
      res = kProbeTargetUtilization * recvBps;
    }
    return clamp(res, this.maxBitrateBps);
  }

  private pickClusterToFill(): ActiveCluster | undefined {
    // Prefer the cluster that still needs sent bytes (lowest id first).
    const needing = this.active
      .filter((c) => c.sentBytes < c.config.minBytes)
      .sort((a, b) => a.config.id - b.config.id);
    if (needing.length > 0) return needing[0];
    // All filled on send side — still tag against highest-id active for ACKs.
    return this.active[this.active.length - 1];
  }

  private dropClusterSeqs(clusterId: number) {
    for (const [seq, id] of this.seqToCluster) {
      if (id === clusterId) this.seqToCluster.delete(seq);
    }
  }

  private cooldownElapsed(nowMs: number): boolean {
    if (!Number.isFinite(this.lastProbeEndMs)) return true;
    return nowMs - this.lastProbeEndMs >= kProbeMinIntervalMs;
  }

  private initiateExponentialProbing(nowMs: number): ProbeClusterConfig[] {
    const bitrates = kProbeBitrateMultipliers.map((s) =>
      clamp(this.startBitrateBps * s, this.maxBitrateBps),
    );
    return this.enqueueClusters(nowMs, bitrates, true);
  }

  private enqueueClusters(
    nowMs: number,
    bitrates: number[],
    activateAll: boolean,
  ): ProbeClusterConfig[] {
    const configs: ProbeClusterConfig[] = [];
    for (const bps of bitrates) {
      const minBytes = Math.max(
        kProbeMinPackets * 200,
        Math.ceil((bps / 8) * (kProbeMinDurationMs / 1000)),
      );
      const config: ProbeClusterConfig = {
        id: this.nextClusterId++,
        targetBps: bps,
        minPackets: kProbeMinPackets,
        minDurationMs: kProbeMinDurationMs,
        minBytes,
      };
      configs.push(config);
      this.queue.push(config);
    }
    if (bitrates.length) {
      this.state = "waiting_for_result";
    }
    if (activateAll) {
      return this.activateAllQueued(nowMs);
    }
    return this.maybeActivateQueued(nowMs);
  }

  private activateAllQueued(nowMs: number): ProbeClusterConfig[] {
    const started: ProbeClusterConfig[] = [];
    while (this.queue.length > 0) {
      const config = this.queue.shift()!;
      this.active.push(this.newActive(config, nowMs));
      started.push(config);
    }
    if (started.length) this.state = "waiting_for_result";
    return started;
  }

  private maybeActivateQueued(nowMs: number): ProbeClusterConfig[] {
    if (this.active.length > 0 || this.queue.length === 0) return [];
    const config = this.queue.shift()!;
    this.active.push(this.newActive(config, nowMs));
    this.state = "waiting_for_result";
    return [config];
  }

  private newActive(config: ProbeClusterConfig, nowMs: number): ActiveCluster {
    return {
      config,
      startMs: nowMs,
      sentBytes: 0,
      sentPackets: 0,
      firstSendMs: 0,
      lastSendMs: 0,
      sizeLastSend: 0,
      ackedBytes: 0,
      ackedPackets: 0,
      firstRecvMs: 0,
      lastRecvMs: 0,
      sizeFirstRecv: 0,
    };
  }
}

function clamp(bps: number, maxBps = kMaxBitrateBps) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), maxBps);
}
