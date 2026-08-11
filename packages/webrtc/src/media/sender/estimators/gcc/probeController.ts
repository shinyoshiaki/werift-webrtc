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
  kProbePacingTimeoutMs,
  kProbeRecoveryMaxScale,
  kProbeRecoveryScale,
  kProbeResultTimeoutMs,
  kProbeTargetUtilization,
} from "./constants";

/**
 * libwebrtc ProbeController-aligned states:
 * - init: no probing initiated yet
 * - waiting_for_result: pacing and/or awaiting-ACK clusters outstanding
 * - complete: initial exponential probing finished (success or failure)
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
 *
 * Rate math uses **ACKed** packets only (libwebrtc ProbeBitrateEstimator),
 * with min/max send and receive times (order-independent).
 */
interface ClusterRuntime {
  config: ProbeClusterConfig;
  /** Sender-clock (Date.now / milliTime) when pacing for this cluster started. */
  startMs: number;
  // Send-side (all probation sends — for send-fill / timeout only)
  sentBytes: number;
  sentPackets: number;
  firstSendMs: number;
  lastSendMs: number;
  // ACKed-only aggregation (ProbeBitrateEstimator)
  ackedBytes: number;
  ackedPackets: number;
  /** min send time among ACKed probe packets */
  firstAckedSendMs: number;
  /** max send time among ACKed probe packets */
  lastAckedSendMs: number;
  /** size of the ACKed packet with max send time */
  sizeLastAckedSend: number;
  /** min receive time among ACKed probe packets */
  firstRecvMs: number;
  /** max receive time among ACKed probe packets */
  lastRecvMs: number;
  /** size of the ACKed packet with min receive time */
  sizeFirstRecv: number;
  /**
   * At least one valid estimate has been produced (80%+ ACKed).
   * Further ACKs still update stats and may overwrite pending estimate.
   */
  resultAccepted: boolean;
}

/**
 * Probe controller (libwebrtc ProbeController + BitrateProber FIFO +
 * ProbeBitrateEstimator).
 *
 * Pacing vs result-wait are **separated** (libwebrtc BitrateProber):
 * - `pacing`: cluster currently being sent (at most one)
 * - `awaitingResults`: send-fill done; ProbeController still waiting for a
 *   result to decide further probing (sender-clock 1s lifetime)
 * - `estimatorHistory`: ProbeBitrateEstimator clusters kept after controller
 *   timeout so late TWCC can still produce estimates (receive-timeline 1s)
 * - On **send** fill (minBytes AND minPackets), front is moved to awaiting and
 *   the next queued cluster becomes pacing — **without waiting for ACK**
 * - ACK / 80% estimate must **never** clear pacing (send-fill is independent)
 * - Controller timeout / cooldown / startMs use **sender clock**; estimator
 *   history prune uses **receive timeline** (`receivedAtMs`)
 * - `setBitrates` / activate returns only **activated** configs (for pacing)
 */
export class ProbeController {
  private state: ProbeState = "init";
  private nextClusterId = 1;
  /** Cluster currently being paced/sent (FIFO front). */
  private pacing: ClusterRuntime | undefined;
  /**
   * Send-complete clusters while ProbeController still waits for a result
   * (further-probe decision). Cleared on sender-clock 1s timeout without
   * dropping ProbeBitrateEstimator seq maps.
   */
  private awaitingResults = new Map<number, ClusterRuntime>();
  /**
   * Clusters retained for late TWCC measurement after controller wait ends
   * (libwebrtc ProbeBitrateEstimator cluster history).
   */
  private estimatorHistory = new Map<number, ClusterRuntime>();
  private queue: ProbeClusterConfig[] = [];
  private estimatedBps = 0;
  private pendingEstimateBps = 0;
  private lastProbeTargetBps = 0;
  /**
   * Further-probe threshold from the **last planned** cluster target
   * (libwebrtc min_bitrate_to_probe_further = last_pending_target × 0.7),
   * not from the last successful result.
   */
  private minBitrateToProbeFurther = 0;
  /** Sender-clock time when last probe session ended. */
  private lastProbeEndMs = Number.NEGATIVE_INFINITY;
  private minBitrateBps = kMinBitrateBps;
  private startBitrateBps = kDefaultStartBitrateBps;
  private maxBitrateBps = kMaxBitrateBps;
  private networkAvailable = true;
  /** transport-wide seq → cluster id for probation packets. */
  private seqToCluster = new Map<number, number>();
  /** transport-wide seq → send-time / size for ACKed-only rate math. */
  private seqToSendInfo = new Map<number, { sendMs: number; size: number }>();

  reset(_atTimeMs = 0) {
    this.state = "init";
    this.nextClusterId = 1;
    this.pacing = undefined;
    this.awaitingResults.clear();
    this.estimatorHistory.clear();
    this.queue = [];
    this.estimatedBps = 0;
    this.pendingEstimateBps = 0;
    this.lastProbeTargetBps = 0;
    this.minBitrateToProbeFurther = 0;
    this.lastProbeEndMs = Number.NEGATIVE_INFINITY;
    this.minBitrateBps = kMinBitrateBps;
    this.startBitrateBps = kDefaultStartBitrateBps;
    this.maxBitrateBps = kMaxBitrateBps;
    this.networkAvailable = true;
    this.seqToCluster.clear();
    this.seqToSendInfo.clear();
  }

  get probeState(): ProbeState {
    return this.state;
  }

  get estimatedBitrateBps() {
    return this.estimatedBps;
  }

  /** Pacing target = current pacing cluster only (not queued, not awaiting). */
  get currentProbeTargetBps() {
    return this.pacing?.config.targetBps ?? 0;
  }

  get suggestedProbeBitrateBps() {
    return this.currentProbeTargetBps;
  }

  get activeClusterCount() {
    return this.pacing ? 1 : 0;
  }

  get queuedClusterCount() {
    return this.queue.length;
  }

  get awaitingResultCount() {
    return this.awaitingResults.size;
  }

  /** Clusters kept only for late TWCC measurement (tests / diagnostics). */
  get estimatorHistoryCount() {
    return this.estimatorHistory.size;
  }

  /** Exposed for tests / diagnostics (last planned further-probe threshold). */
  get furtherProbeThresholdBps() {
    return this.minBitrateToProbeFurther;
  }

  takePendingEstimateBps(): number {
    const v = this.pendingEstimateBps;
    this.pendingEstimateBps = 0;
    return v;
  }

  shouldTagProbePacket(): boolean {
    return this.pacing !== undefined && !this.sendFillComplete(this.pacing);
  }

  private sendFillComplete(c: ClusterRuntime): boolean {
    return (
      c.sentPackets >= c.config.minPackets && c.sentBytes >= c.config.minBytes
    );
  }

  /**
   * Bytes still needed for the **pacing** cluster (padding injection).
   */
  remainingProbeBytes(packetBytes = 200): number {
    if (!this.pacing) return 0;
    const c = this.pacing;
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
    // libwebrtc ProbeController keeps start bitrate as the initial estimate.
    if (this.estimatedBps <= 0) {
      this.estimatedBps = this.startBitrateBps;
    }
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
    const uncapped = Math.min(
      base * kProbeRecoveryScale,
      base * kProbeRecoveryMaxScale,
    );
    const target = clamp(uncapped, this.maxBitrateBps);
    if (target <= base * 1.05) return [];
    // libwebrtc: bitrate >= max_probe_bitrate → clamp + probe_further=false.
    const stopFurtherAfter = uncapped >= this.maxBitrateBps;
    return this.enqueueClusters(nowMs, [target], { stopFurtherAfter });
  }

  setEstimatedBitrate(bitrateBps: number, nowMs: number): ProbeClusterConfig[] {
    if (!this.cooldownElapsed(nowMs) && this.state === "complete") {
      return [];
    }
    // Further-probe uses last **planned** target threshold, not last success.
    // Infinity disables further probes after a max-bitrate last cluster.
    if (
      this.minBitrateToProbeFurther > 0 &&
      Number.isFinite(this.minBitrateToProbeFurther) &&
      bitrateBps > this.minBitrateToProbeFurther &&
      (this.state === "complete" || this.state === "waiting_for_result")
    ) {
      const uncapped = Math.min(
        bitrateBps * kFurtherProbeStepMultiplier,
        bitrateBps * kProbeRecoveryMaxScale,
      );
      const next = clamp(uncapped, this.maxBitrateBps);
      // libwebrtc InitiateProbing: bitrate >= max_probe_bitrate → clamp + stop.
      const stopFurtherAfter = uncapped >= this.maxBitrateBps;
      return this.enqueueClusters(nowMs, [next], { stopFurtherAfter });
    }
    return [];
  }

  /**
   * Advance **controller** timeouts using sender clock (`nowMs` = milliTime).
   * Does not erase ProbeBitrateEstimator seq maps — late TWCC may still
   * produce estimates from {@link estimatorHistory}.
   * Returns newly activated pacing configs (if any).
   */
  process(nowMs: number): ProbeClusterConfig[] {
    // BitrateProber: pacing cluster that never filled — 5s.
    // Stop pacing but keep sent packets measurable for late TWCC.
    if (this.pacing && nowMs - this.pacing.startMs > kProbePacingTimeoutMs) {
      this.moveToEstimatorHistory(this.pacing);
      this.pacing = undefined;
    }
    // ProbeController: result wait after send-fill — 1s from last send.
    // Controller leaves waiting_for_result; estimator history stays.
    for (const [id, c] of this.awaitingResults) {
      const waitStart = c.lastSendMs > 0 ? c.lastSendMs : c.startMs;
      if (nowMs - waitStart > kProbeResultTimeoutMs) {
        this.awaitingResults.delete(id);
        this.moveToEstimatorHistory(c);
      }
    }
    const activated = this.maybeActivateQueued(nowMs);
    this.maybeMarkComplete(nowMs);
    return activated;
  }

  /**
   * Record a probation packet at **send** time (sender clock = sendMs).
   * When minBytes AND minPackets are met, pops pacing → awaitingResults and
   * activates the next queued cluster (libwebrtc BitrateProber::ProbeSent).
   *
   * @returns newly activated pacing configs (may include the next FIFO cluster)
   */
  onProbePacketSent(
    sizeBytes: number,
    sendMs: number,
    wideSeq: number,
  ): { clusterId: number; activated: ProbeClusterConfig[] } {
    if (!this.pacing) {
      return { clusterId: 0, activated: [] };
    }
    if (this.sendFillComplete(this.pacing)) {
      // Already full — advance if somehow still pacing.
      return {
        clusterId: this.pacing.config.id,
        activated: this.finishPacingSend(sendMs),
      };
    }

    const cluster = this.pacing;
    const seq = wideSeq & 0xffff;
    this.seqToCluster.set(seq, cluster.config.id);
    this.seqToSendInfo.set(seq, { sendMs, size: sizeBytes });

    if (cluster.sentPackets === 0) {
      cluster.firstSendMs = sendMs;
    }
    cluster.lastSendMs = sendMs;
    cluster.sentBytes += sizeBytes;
    cluster.sentPackets += 1;

    if (this.sendFillComplete(cluster)) {
      return {
        clusterId: cluster.config.id,
        activated: this.finishPacingSend(sendMs),
      };
    }
    return { clusterId: cluster.config.id, activated: [] };
  }

  /**
   * Move pacing cluster to awaiting-results (or settle if result already
   * accepted) and activate next from queue.
   * Uses **sender clock** for the new cluster's startMs.
   */
  private finishPacingSend(senderNowMs: number): ProbeClusterConfig[] {
    if (!this.pacing) return [];
    const done = this.pacing;
    this.pacing = undefined;
    // Always await TWCC (including late ACKs after an early 80% result).
    // Cluster is removed on result timeout in process(), not on first estimate.
    this.awaitingResults.set(done.config.id, done);

    const activated = this.maybeActivateQueued(senderNowMs);
    this.maybeMarkComplete(senderNowMs);
    return activated;
  }

  /**
   * ACK a probe packet. Credits the cluster that owned wideSeq (pacing or
   * awaiting). Does **not** advance or clear FIFO pacing — send-fill only.
   *
   * Rate stats use min/max of ACKed send/receive times (libwebrtc
   * ProbeBitrateEstimator / SortedByReceiveTime semantics) so reorder does
   * not invert the receive interval.
   *
   * 80% ACK is the *minimum* to produce an estimate; further ACKs keep
   * updating cluster stats and may overwrite the pending estimate.
   *
   * @param receivedAtMs TWCC receiver timeline (rate math only)
   * @param senderNowMs sender clock for session completion / cooldown
   * @param sendingAtMs optional send time; defaults to seq map from ProbeSent
   */
  onAckedPacket(
    sizeBytes: number,
    receivedAtMs: number,
    isProbe: boolean,
    wideSeq: number | undefined,
    senderNowMs: number,
    sendingAtMs?: number,
  ): void {
    if (!isProbe) return;

    // Prune estimator history first (libwebrtc EraseOldClusters on receive time).
    this.eraseOldEstimatorClusters(receivedAtMs);

    let cluster: ClusterRuntime | undefined;
    let sendMs = sendingAtMs;
    if (wideSeq !== undefined) {
      const seq = wideSeq & 0xffff;
      const id = this.seqToCluster.get(seq);
      if (id !== undefined) {
        cluster = this.lookupCluster(id);
      }
      if (sendMs === undefined) {
        sendMs = this.seqToSendInfo.get(seq)?.sendMs;
      }
    } else if (this.pacing && this.awaitingResults.size === 0) {
      // Unit-test fallback without seq map.
      cluster = this.pacing;
    }
    if (!cluster) return;
    // Need a send timestamp for ACKed-only send-rate math.
    if (sendMs === undefined || !Number.isFinite(sendMs)) {
      // Last resort: use cluster send span endpoints (less accurate).
      sendMs =
        cluster.ackedPackets === 0
          ? cluster.firstSendMs || cluster.lastSendMs
          : cluster.lastSendMs;
    }
    if (!Number.isFinite(sendMs) || sendMs <= 0) return;

    // libwebrtc-style min/max aggregation (order-independent).
    if (cluster.ackedPackets === 0) {
      cluster.firstAckedSendMs = sendMs;
      cluster.lastAckedSendMs = sendMs;
      cluster.sizeLastAckedSend = sizeBytes;
      cluster.firstRecvMs = receivedAtMs;
      cluster.lastRecvMs = receivedAtMs;
      cluster.sizeFirstRecv = sizeBytes;
    } else {
      if (sendMs < cluster.firstAckedSendMs) {
        cluster.firstAckedSendMs = sendMs;
      }
      if (sendMs > cluster.lastAckedSendMs) {
        cluster.lastAckedSendMs = sendMs;
        cluster.sizeLastAckedSend = sizeBytes;
      }
      if (receivedAtMs < cluster.firstRecvMs) {
        cluster.firstRecvMs = receivedAtMs;
        cluster.sizeFirstRecv = sizeBytes;
      }
      if (receivedAtMs > cluster.lastRecvMs) {
        cluster.lastRecvMs = receivedAtMs;
      }
    }
    cluster.ackedBytes += sizeBytes;
    cluster.ackedPackets += 1;

    const estimate = this.estimateClusterBitrate(cluster);
    if (estimate === undefined) return;

    // Always surface latest valid result (up or down). Later ACKs overwrite.
    this.pendingEstimateBps = estimate;
    if (estimate > this.estimatedBps) {
      this.estimatedBps = estimate;
    }
    this.lastProbeTargetBps = Math.max(
      this.lastProbeTargetBps,
      cluster.config.targetBps,
    );
    cluster.resultAccepted = true;
    // Controller awaiting / estimator history keep seq maps until their
    // respective lifetimes end so the remaining 20% of ACKs can refine.
    void senderNowMs;
  }

  abort(nowMs: number) {
    this.pacing = undefined;
    this.awaitingResults.clear();
    this.estimatorHistory.clear();
    this.queue = [];
    this.seqToCluster.clear();
    this.seqToSendInfo.clear();
    if (this.state === "waiting_for_result") {
      // After probing was initiated, failures still end in complete so
      // recovery probing remains available (libwebrtc kProbingComplete).
      this.state = "complete";
      this.lastProbeEndMs = nowMs;
    }
  }

  /** Resolve cluster across pacing / controller-await / estimator history. */
  private lookupCluster(id: number): ClusterRuntime | undefined {
    if (this.pacing?.config.id === id) return this.pacing;
    return this.awaitingResults.get(id) ?? this.estimatorHistory.get(id);
  }

  private moveToEstimatorHistory(c: ClusterRuntime) {
    this.estimatorHistory.set(c.config.id, c);
  }

  /**
   * libwebrtc ProbeBitrateEstimator::EraseOldClusters — drop clusters whose
   * last receive is more than {@link kProbeResultTimeoutMs} before `receiveTimeMs`.
   */
  private eraseOldEstimatorClusters(receiveTimeMs: number) {
    for (const [id, c] of this.estimatorHistory) {
      if (c.lastRecvMs > 0 && receiveTimeMs - c.lastRecvMs > kProbeResultTimeoutMs) {
        this.dropClusterSeqs(id);
        this.estimatorHistory.delete(id);
      }
    }
  }

  private maybeMarkComplete(senderNowMs: number) {
    if (
      !this.pacing &&
      this.awaitingResults.size === 0 &&
      this.queue.length === 0 &&
      this.state === "waiting_for_result"
    ) {
      this.lastProbeEndMs = senderNowMs;
      // Always complete once a session was started — even if every cluster
      // timed out / failed. Returning to init permanently disables recovery
      // because ensureProbing() will not re-run setBitrates().
      this.state = "complete";
    }
  }

  /**
   * libwebrtc ProbeBitrateEstimator validation on **ACKed** packets only:
   * sendInterval = max(ack send) − min(ack send)
   * recvInterval = max(ack recv) − min(ack recv)
   * sizes exclude the last-sent and first-received packet payloads.
   */
  private estimateClusterBitrate(c: ClusterRuntime): number | undefined {
    const minProbes = Math.ceil(
      (c.config.minPackets * kProbeMinReceivedProbesPercent) / 100,
    );
    const minBytes = Math.ceil(
      (c.config.minBytes * kProbeMinReceivedBytesPercent) / 100,
    );
    if (c.ackedPackets < minProbes || c.ackedBytes < minBytes) {
      return undefined;
    }

    const sendIntervalMs = c.lastAckedSendMs - c.firstAckedSendMs;
    const recvIntervalMs = c.lastRecvMs - c.firstRecvMs;
    if (
      sendIntervalMs <= 0 ||
      sendIntervalMs > kProbeMaxIntervalMs ||
      recvIntervalMs <= 0 ||
      recvIntervalMs > kProbeMaxIntervalMs
    ) {
      return undefined;
    }

    const sendSize = Math.max(0, c.ackedBytes - c.sizeLastAckedSend);
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
      if (id === clusterId) {
        this.seqToCluster.delete(seq);
        this.seqToSendInfo.delete(seq);
      }
    }
  }

  private cooldownElapsed(nowMs: number): boolean {
    if (!Number.isFinite(this.lastProbeEndMs)) return true;
    return nowMs - this.lastProbeEndMs >= kProbeMinIntervalMs;
  }

  private initiateExponentialProbing(nowMs: number): ProbeClusterConfig[] {
    const uncapped = kProbeBitrateMultipliers.map(
      (s) => this.startBitrateBps * s,
    );
    const bitrates = uncapped.map((b) => clamp(b, this.maxBitrateBps));
    // If the last step is limited by max_bitrate (>= max), do not schedule
    // further probes after the initial session (libwebrtc probe_further=false).
    const stopFurtherAfter =
      uncapped[uncapped.length - 1]! >= this.maxBitrateBps;
    // Only return **activated** configs (front 3x). 6x stays queued until
    // 3x send-fill completes (BitrateProber FIFO).
    return this.enqueueClusters(nowMs, bitrates, { stopFurtherAfter });
  }

  private enqueueClusters(
    nowMs: number,
    bitrates: number[],
    opts?: { stopFurtherAfter?: boolean },
  ): ProbeClusterConfig[] {
    for (const bps of bitrates) {
      const minBytes = Math.max(
        kProbeMinPackets * 200,
        Math.ceil((bps / 8) * (kProbeMinDurationMs / 1000)),
      );
      this.queue.push({
        id: this.nextClusterId++,
        targetBps: bps,
        minPackets: kProbeMinPackets,
        minDurationMs: kProbeMinDurationMs,
        minBytes,
      });
    }
    if (bitrates.length) {
      if (opts?.stopFurtherAfter) {
        // No more exponential further probes after max-bitrate last cluster.
        this.minBitrateToProbeFurther = Number.POSITIVE_INFINITY;
      } else {
        // libwebrtc: min_bitrate_to_probe_further = last planned target × 0.7
        // (for initial session: 6x × 0.7, not 3x after first success).
        const lastPlanned = bitrates[bitrates.length - 1]!;
        this.minBitrateToProbeFurther = Math.round(
          lastPlanned * kFurtherProbeThreshold,
        );
      }
      this.state = "waiting_for_result";
    }
    return this.maybeActivateQueued(nowMs);
  }

  private maybeActivateQueued(nowMs: number): ProbeClusterConfig[] {
    if (this.pacing || this.queue.length === 0) return [];
    const config = this.queue.shift()!;
    this.pacing = this.newRuntime(config, nowMs);
    this.state = "waiting_for_result";
    return [config];
  }

  private newRuntime(
    config: ProbeClusterConfig,
    senderStartMs: number,
  ): ClusterRuntime {
    return {
      config,
      startMs: senderStartMs,
      sentBytes: 0,
      sentPackets: 0,
      firstSendMs: 0,
      lastSendMs: 0,
      ackedBytes: 0,
      ackedPackets: 0,
      firstAckedSendMs: 0,
      lastAckedSendMs: 0,
      sizeLastAckedSend: 0,
      firstRecvMs: 0,
      lastRecvMs: 0,
      sizeFirstRecv: 0,
      resultAccepted: false,
    };
  }
}

function clamp(bps: number, maxBps = kMaxBitrateBps) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), maxBps);
}
