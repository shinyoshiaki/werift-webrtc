import {
  kDefaultStartBitrateBps,
  kFurtherProbeStepMultiplier,
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
 * - `setBitrates` / cold start → exponential probe clusters (×3 and ×6)
 * - **Multi-active**: initial 3x/6x (and any co-enqueued set) can be active
 *   simultaneously; pacing target is the max among active clusters
 * - On successful TWCC-measured probe, may schedule further probing when the
 *   estimate exceeds `further_probe_threshold` × last probe size
 *
 * The sender must raise its pacing rate to `currentProbeTargetBps` and tag
 * packets with `isProbation` while any cluster is active.
 */
export class ProbeController {
  private state: ProbeState = "init";
  private nextClusterId = 1;
  /** Multiple clusters may be active (libwebrtc InitiateProbing returns both). */
  private active: ActiveCluster[] = [];
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
    this.active = [];
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

  /** Max active cluster pacing target (0 if none). */
  get currentProbeTargetBps() {
    if (this.active.length === 0) return 0;
    return Math.max(...this.active.map((c) => c.config.targetBps));
  }

  /** Alias used by callers expecting “suggested” naming. */
  get suggestedProbeBitrateBps() {
    return this.currentProbeTargetBps;
  }

  /** Number of currently active probe clusters. */
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
    return this.enqueueClusters(nowMs, [target], /*activateAll*/ false);
  }

  setEstimatedBitrate(bitrateBps: number, nowMs: number): ProbeClusterConfig[] {
    if (
      this.lastProbeTargetBps > 0 &&
      bitrateBps > this.lastProbeTargetBps * kFurtherProbeThreshold &&
      (this.state === "complete" || this.state === "waiting_for_result")
    ) {
      const next = clamp(
        bitrateBps * kFurtherProbeStepMultiplier,
        this.maxBitrateBps,
      );
      return this.enqueueClusters(nowMs, [next], false);
    }
    return [];
  }

  /**
   * Advance timeouts / promote queued clusters.
   */
  process(nowMs: number): ProbeClusterConfig[] {
    const remaining: ActiveCluster[] = [];
    for (const c of this.active) {
      if (nowMs - c.startMs > kProbeResultTimeoutMs) {
        // Timed out — drop this cluster.
        continue;
      }
      remaining.push(c);
    }
    this.active = remaining;
    if (
      this.active.length === 0 &&
      this.queue.length === 0 &&
      this.state === "waiting_for_result"
    ) {
      this.state = this.estimatedBps > 0 ? "complete" : "init";
    }
    return this.maybeActivateQueued(nowMs);
  }

  onAckedPacket(sizeBytes: number, receivedAtMs: number, isProbe: boolean) {
    if (this.active.length === 0 || !isProbe) return;

    // Credit every active cluster (lightweight pacer has no per-packet cluster id).
    const completed: ProbeClusterConfig[] = [];
    for (const c of this.active) {
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
        const clamped = clamp(bps, this.maxBitrateBps);
        if (clamped > this.estimatedBps) {
          this.estimatedBps = clamped;
          this.pendingEstimateBps = Math.max(
            this.pendingEstimateBps,
            this.estimatedBps,
          );
        }
        this.lastProbeTargetBps = Math.max(
          this.lastProbeTargetBps,
          c.config.targetBps,
        );
        completed.push(c.config);
      }
    }

    if (completed.length > 0) {
      const doneIds = new Set(completed.map((c) => c.id));
      this.active = this.active.filter((c) => !doneIds.has(c.config.id));
      if (this.active.length === 0 && this.queue.length === 0) {
        this.state = "complete";
      }
    }
  }

  abort(nowMs: number) {
    this.active = [];
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
    // libwebrtc InitiateProbing returns both 3x and 6x in one call.
    return this.enqueueClusters(nowMs, bitrates, /*activateAll*/ true);
  }

  /**
   * Enqueue probe clusters. When `activateAll` is true (initial exponential),
   * all configs become active immediately and are returned as started.
   * Otherwise only the first free slot is activated (further/request probes).
   */
  private enqueueClusters(
    nowMs: number,
    bitrates: number[],
    activateAll: boolean,
  ): ProbeClusterConfig[] {
    const configs: ProbeClusterConfig[] = [];
    for (const bps of bitrates) {
      const config: ProbeClusterConfig = {
        id: this.nextClusterId++,
        targetBps: bps,
        minPackets: kProbeMinPackets,
        minDurationMs: kProbeMinDurationMs,
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
      this.active.push({
        config,
        startMs: nowMs,
        bytes: 0,
        packets: 0,
        firstRecvMs: 0,
        lastRecvMs: 0,
      });
      started.push(config);
    }
    if (started.length) {
      this.state = "waiting_for_result";
    }
    return started;
  }

  private maybeActivateQueued(nowMs: number): ProbeClusterConfig[] {
    // Further/request probes: only one additional active if none running.
    if (this.active.length > 0 || this.queue.length === 0) return [];
    const config = this.queue.shift()!;
    this.active.push({
      config,
      startMs: nowMs,
      bytes: 0,
      packets: 0,
      firstRecvMs: 0,
      lastRecvMs: 0,
    });
    this.state = "waiting_for_result";
    return [config];
  }
}

function clamp(bps: number, maxBps = kMaxBitrateBps) {
  return Math.min(Math.max(Math.round(bps), kMinBitrateBps), maxBps);
}
