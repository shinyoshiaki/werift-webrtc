import {
  kDefaultStartBitrateBps,
  kFurtherProbeThreshold,
  kMaxBitrateBps,
  kMinBitrateBps,
  kProbeBitrateMultipliers,
  kProbeMinDurationMs,
  kProbeMinPackets,
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
}

interface ActiveCluster {
  config: ProbeClusterConfig;
  startMs: number;
  bytes: number;
  packets: number;
  firstRecvMs: number;
  lastRecvMs: number;
}

/**
 * Probe controller (libwebrtc `ProbeController` structure).
 *
 * - `setBitrates` / cold start → exponential probe clusters (× first/second scale)
 * - While waiting, `currentProbeTargetBps` is the pacing target for the sender
 * - On successful TWCC-measured probe, may schedule further probing when the
 *   estimate exceeds `further_probe_threshold` × last probe size
 *
 * The sender must raise its pacing rate to `currentProbeTargetBps` and tag
 * packets with `isProbation` while a cluster is active.
 */
export class ProbeController {
  private state: ProbeState = "init";
  private nextClusterId = 1;
  private active?: ActiveCluster;
  private queue: ProbeClusterConfig[] = [];
  private estimatedBps = 0;
  private pendingEstimateBps = 0;
  private lastProbeTargetBps = 0;
  private minBitrateBps = kMinBitrateBps;
  private startBitrateBps = kDefaultStartBitrateBps;
  private maxBitrateBps = kMaxBitrateBps;
  private networkAvailable = true;

  reset(_atTimeMs = 0) {
    this.state = "init";
    this.nextClusterId = 1;
    this.active = undefined;
    this.queue = [];
    this.estimatedBps = 0;
    this.pendingEstimateBps = 0;
    this.lastProbeTargetBps = 0;
    this.minBitrateBps = kMinBitrateBps;
    this.startBitrateBps = kDefaultStartBitrateBps;
    this.maxBitrateBps = kMaxBitrateBps;
    this.networkAvailable = true;
  }

  get probeState(): ProbeState {
    return this.state;
  }

  get estimatedBitrateBps() {
    return this.estimatedBps;
  }

  /** Active cluster pacing target (0 if none). */
  get currentProbeTargetBps() {
    return this.active?.config.targetBps ?? 0;
  }

  /** Alias used by callers expecting “suggested” naming. */
  get suggestedProbeBitrateBps() {
    return this.currentProbeTargetBps;
  }

  takePendingEstimateBps(): number {
    const v = this.pendingEstimateBps;
    this.pendingEstimateBps = 0;
    return v;
  }

  shouldTagProbePacket(): boolean {
    return !!this.active;
  }

  /**
   * libwebrtc SetBitrates — configure bounds and initiate exponential probing
   * when still in the init state.
   */
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

  /** Application / recovery request for additional probes. */
  requestProbe(estimatedBps: number, nowMs: number): ProbeClusterConfig[] {
    if (this.state === "waiting_for_result") return [];
    const base = Math.max(
      estimatedBps,
      this.startBitrateBps,
      kDefaultStartBitrateBps,
    );
    const target = clamp(base * 1.5, this.maxBitrateBps);
    return this.enqueueClusters(nowMs, [target], /*probeFurther*/ false);
  }

  setEstimatedBitrate(bitrateBps: number, nowMs: number): ProbeClusterConfig[] {
    if (
      this.state === "complete" &&
      this.lastProbeTargetBps > 0 &&
      bitrateBps > this.lastProbeTargetBps * kFurtherProbeThreshold
    ) {
      const next = clamp(
        bitrateBps * kProbeBitrateMultipliers[0],
        this.maxBitrateBps,
      );
      return this.enqueueClusters(nowMs, [next], true);
    }
    return [];
  }

  /**
   * Advance timeouts / promote queued clusters.
   */
  process(nowMs: number): ProbeClusterConfig[] {
    if (this.active && nowMs - this.active.startMs > kProbeResultTimeoutMs) {
      // Timed out waiting for enough acks — drop cluster, continue queue.
      this.active = undefined;
      if (this.queue.length === 0 && this.state === "waiting_for_result") {
        this.state = this.estimatedBps > 0 ? "complete" : "init";
      }
    }
    return this.maybeActivateNext(nowMs);
  }

  onAckedPacket(sizeBytes: number, receivedAtMs: number, isProbe: boolean) {
    if (!this.active || !isProbe) return;
    const c = this.active;
    c.bytes += sizeBytes;
    c.packets += 1;
    if (c.firstRecvMs === 0) c.firstRecvMs = receivedAtMs;
    c.lastRecvMs = receivedAtMs;

    const durationMs = c.lastRecvMs - c.firstRecvMs;
    if (
      c.packets >= c.config.minPackets &&
      durationMs >= c.config.minDurationMs
    ) {
      const bps = (c.bytes * 8 * 1000) / Math.max(durationMs, 1);
      this.estimatedBps = clamp(bps, this.maxBitrateBps);
      this.pendingEstimateBps = this.estimatedBps;
      this.lastProbeTargetBps = c.config.targetBps;
      this.active = undefined;
      if (this.queue.length === 0) {
        this.state = "complete";
      }
    }
  }

  abort(nowMs: number) {
    this.active = undefined;
    this.queue = [];
    if (this.state === "waiting_for_result") {
      this.state = this.estimatedBps > 0 ? "complete" : "init";
    }
    void nowMs;
  }

  private initiateExponentialProbing(nowMs: number): ProbeClusterConfig[] {
    const scales = [...kProbeBitrateMultipliers];
    const bitrates = scales.map((s) =>
      clamp(this.startBitrateBps * s, this.maxBitrateBps),
    );
    return this.enqueueClusters(nowMs, bitrates, true);
  }

  private enqueueClusters(
    nowMs: number,
    bitrates: number[],
    _probeFurther: boolean,
  ): ProbeClusterConfig[] {
    const created: ProbeClusterConfig[] = [];
    for (const bps of bitrates) {
      const config: ProbeClusterConfig = {
        id: this.nextClusterId++,
        targetBps: bps,
        minPackets: kProbeMinPackets,
        minDurationMs: kProbeMinDurationMs,
      };
      this.queue.push(config);
      created.push(config);
    }
    if (created.length) {
      this.state = "waiting_for_result";
    }
    this.maybeActivateNext(nowMs);
    return created;
  }

  private maybeActivateNext(nowMs: number): ProbeClusterConfig[] {
    if (this.active || this.queue.length === 0) return [];
    const config = this.queue.shift()!;
    this.active = {
      config,
      startMs: nowMs,
      bytes: 0,
      packets: 0,
      firstRecvMs: 0,
      lastRecvMs: 0,
    };
    this.state = "waiting_for_result";
    return [config];
  }
}

function clamp(bps: number, maxBps = kMaxBitrateBps) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), maxBps);
}
