import {
  kDefaultStartBitrateBps,
  kFurtherProbeStepMultiplier,
  kFurtherProbeThreshold,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeBitrateMultipliers,
  kProbeMaxIntervalMs,
  kProbeMaxValidRatio,
  kProbeMinDurationMs,
  kProbeMinIntervalMs,
  kProbeMinPackets,
  kProbeMinRatioForUnsaturated,
  kProbeMinReceivedBytesPercent,
  kProbeMinReceivedProbesPercent,
  kProbeRecoveryMaxScale,
  kProbeRecoveryScale,
  kProbeResultTimeoutMs,
  kProbeTargetUtilization,
} from "./constants";

/**
 * libwebrtc ProbeController-aligned states:
 * - init: no probing initiated yet
 * - waiting_for_result: cluster(s) outstanding (queued and/or front active)
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
 * Probe controller (libwebrtc `ProbeController` + `ProbeBitrateEstimator` +
 * BitrateProber FIFO semantics).
 *
 * - `setBitrates` / cold start creates exponential configs (×3 then ×6)
 * - Configs are **queued**; only the **front** cluster is active for pacing
 *   and packet assignment (libwebrtc BitrateProber FIFO — not multi-active)
 * - InitiateProbing may still **return** both configs (started events) so the
 *   app can see planned clusters; only one is paced at a time
 * - Send fill requires **minBytes AND minPackets**; ACK validation uses 80%
 * - Recovery probes use current estimate + cooldown
 */
export class ProbeController {
  private state: ProbeState = "init";
  private nextClusterId = 1;
  /** At most one active cluster (FIFO front). */
  private active: ActiveCluster | undefined;
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

  reset(_atTimeMs = 0) {
    this.state = "init";
    this.nextClusterId = 1;
    this.active = undefined;
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
  }

  get probeState(): ProbeState {
    return this.state;
  }

  get estimatedBitrateBps() {
    return this.estimatedBps;
  }

  /** Pacing target = front (only) active cluster bitrate. */
  get currentProbeTargetBps() {
    return this.active?.config.targetBps ?? 0;
  }

  get suggestedProbeBitrateBps() {
    return this.currentProbeTargetBps;
  }

  get activeClusterCount() {
    return this.active ? 1 : 0;
  }

  /** Queued clusters waiting behind the front (e.g. 6x while 3x runs). */
  get queuedClusterCount() {
    return this.queue.length;
  }

  takePendingEstimateBps(): number {
    const v = this.pendingEstimateBps;
    this.pendingEstimateBps = 0;
    return v;
  }

  shouldTagProbePacket(): boolean {
    return this.active !== undefined;
  }

  /**
   * Whether the front cluster still needs more sent packets/bytes.
   */
  private sendFillComplete(c: ActiveCluster): boolean {
    return (
      c.sentPackets >= c.config.minPackets && c.sentBytes >= c.config.minBytes
    );
  }

  /**
   * Bytes still needed for the **front** active cluster (padding injection).
   * Considers both minBytes and a byte proxy for remaining minPackets.
   */
  remainingProbeBytes(packetBytes = 200): number {
    if (!this.active) return 0;
    const c = this.active;
    if (this.sendFillComplete(c)) return 0;
    const needBytes = Math.max(0, c.config.minBytes - c.sentBytes);
    const needPkts = Math.max(0, c.config.minPackets - c.sentPackets);
    const needPktBytes = needPkts * Math.max(1, packetBytes);
    return Math.max(needBytes, needPktBytes);
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
    return this.enqueueClusters(nowMs, [target]);
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
      return this.enqueueClusters(nowMs, [next]);
    }
    return [];
  }

  process(nowMs: number): ProbeClusterConfig[] {
    if (this.active && nowMs - this.active.startMs > kProbeResultTimeoutMs) {
      this.dropClusterSeqs(this.active.config.id);
      this.active = undefined;
    }
    if (!this.active && this.queue.length === 0) {
      if (this.state === "waiting_for_result") {
        this.lastProbeEndMs = nowMs;
        this.state = this.estimatedBps > 0 ? "complete" : "init";
      }
      return [];
    }
    return this.maybeActivateQueued(nowMs);
  }

  /**
   * Record a probation (probe-tagged) packet at send time.
   * Always assigns to the **front** active cluster.
   */
  onProbePacketSent(
    sizeBytes: number,
    sendMs: number,
    wideSeq: number,
  ): number {
    if (!this.active) return 0;
    // Do not over-assign beyond fill goals (BitrateProber stops probing).
    if (this.sendFillComplete(this.active)) return 0;

    const cluster = this.active;
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
   * On completion, pops front and activates the next queued cluster.
   */
  onAckedPacket(
    sizeBytes: number,
    receivedAtMs: number,
    isProbe: boolean,
    wideSeq?: number,
  ): ProbeClusterConfig[] {
    if (!this.active || !isProbe) return [];

    let cluster: ActiveCluster | undefined = this.active;
    if (wideSeq !== undefined) {
      const id = this.seqToCluster.get(wideSeq & 0xffff);
      if (id === undefined || id !== this.active.config.id) {
        // ACK for a previous/unknown cluster — ignore for front validation.
        return [];
      }
      cluster = this.active;
    }

    if (cluster.ackedPackets === 0) {
      cluster.firstRecvMs = receivedAtMs;
      cluster.sizeFirstRecv = sizeBytes;
    }
    cluster.lastRecvMs = receivedAtMs;
    cluster.ackedBytes += sizeBytes;
    cluster.ackedPackets += 1;

    const estimate = this.estimateClusterBitrate(cluster);
    if (estimate === undefined) return [];

    if (estimate > this.estimatedBps) {
      this.estimatedBps = estimate;
      this.pendingEstimateBps = Math.max(this.pendingEstimateBps, estimate);
    }
    this.lastProbeTargetBps = Math.max(
      this.lastProbeTargetBps,
      cluster.config.targetBps,
    );

    // Cluster complete — pop front and activate next (FIFO).
    this.dropClusterSeqs(cluster.config.id);
    this.active = undefined;
    const started = this.maybeActivateQueued(receivedAtMs);
    if (!this.active && this.queue.length === 0) {
      this.state = "complete";
      this.lastProbeEndMs = receivedAtMs;
    }
    return started;
  }

  abort(nowMs: number) {
    this.active = undefined;
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
    // Return all configs (libwebrtc InitiateProbing returns both 3x and 6x)
    // but only activate the front for pacing (BitrateProber FIFO).
    return this.enqueueClusters(nowMs, bitrates, /*returnAll*/ true);
  }

  /**
   * @param returnAll when true (initial exponential), return every created
   *   config for telemetry even though only the front is activated.
   */
  private enqueueClusters(
    nowMs: number,
    bitrates: number[],
    returnAll = false,
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
    const activated = this.maybeActivateQueued(nowMs);
    // For initial probing, surface all planned configs (3x+6x) to the app
    // while only the front is actually paced.
    if (returnAll && configs.length > 0) {
      return configs;
    }
    return activated;
  }

  private maybeActivateQueued(nowMs: number): ProbeClusterConfig[] {
    if (this.active || this.queue.length === 0) return [];
    const config = this.queue.shift()!;
    this.active = this.newActive(config, nowMs);
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
