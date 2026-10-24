import { type BandwidthEstimator, GccBandwidthEstimator } from "../../src";
import { seededRandom, twccSentInfo, wireTwccFeedback } from "./twccTestUtils";

/**
 * Arrange utilities for spec-level GCC control-response tests.
 *
 * A deterministic, millisecond-step model of one sender behind a bottleneck:
 * a FIFO queue with a byte limit drains at `capacityBps`, then adds
 * `baseDelayMs`; random loss is applied after the queue. The receiver emits
 * wire-accurate TWCC (250µs quantization) every `feedbackIntervalMs`, which
 * reaches the sender after the same one-way delay. Probe clusters requested by
 * the estimator are filled with probe-tagged padding, like `RTCRtpSender`.
 *
 * This checks *what* GCC does (back off under congestion, ramp up when the
 * link is free, react to loss / missing feedback), not libwebrtc's exact
 * order of operations or boundary values.
 */

export type GccLink = {
  capacityBps: number;
  baseDelayMs: number;
  /** Bottleneck queue size; packets arriving to a full queue are dropped. */
  queueLimitBytes: number;
  /** Random loss after the queue (0–1). */
  lossRate?: number;
};

export type GccPhase = {
  durationMs: number;
  link: GccLink;
  /**
   * Media rate in bps, or `"follow"` for an application that sends at the
   * estimator's recommended bitrate (`availableBitrate`).
   */
  source: number | "follow";
  /** When false, TWCC feedback is not delivered (feedback stall). */
  feedback?: boolean;
};

export type GccScenario = {
  startBps: number;
  minBps?: number;
  maxBps?: number;
  phases: GccPhase[];
  packetBytes?: number;
  feedbackIntervalMs?: number;
  seed?: number;
  /** Build the estimator under test (default: GCC with the sim clock). */
  createEstimator?: (
    clock: () => number,
    startBps: number,
  ) => BandwidthEstimator;
};

export type GccSimulationResult = {
  estimator: BandwidthEstimator;
  /** Every `onAvailableBitrate` notification with its sim time. */
  events: { tMs: number; bps: number }[];
  /** Recommended bitrate at the end of each phase. */
  phaseEndBps: number[];
  /** Media + probe packets dropped by the bottleneck queue, per phase. */
  queueDrops: number[];
  /** Recommended bitrate sampled every 100ms. */
  samples: { tMs: number; bps: number }[];
  /** Probe-tagged padding packets sent. */
  probePackets: number;
};

type InFlight = {
  ext: number;
  arrivalMs: number | undefined;
};

const kStartMs = 10_000;
const kProbePacketBytes = 224;

/** Act: run the scenario and return the estimator's observable output. */
export function runGccSimulation(scenario: GccScenario): GccSimulationResult {
  const packetBytes = scenario.packetBytes ?? 1_200;
  const feedbackIntervalMs = scenario.feedbackIntervalMs ?? 50;
  const rand = seededRandom(scenario.seed ?? 1);
  let nowMs = kStartMs;
  const clock = () => nowMs;
  const estimator =
    scenario.createEstimator?.(clock, scenario.startBps) ??
    new GccBandwidthEstimator(scenario.startBps, { clock });
  if (estimator instanceof GccBandwidthEstimator) {
    estimator.setBitrates(
      scenario.minBps ?? 0,
      scenario.startBps,
      scenario.maxBps ?? Number.POSITIVE_INFINITY,
    );
  }
  estimator.setNetworkAvailable(true);

  const events: { tMs: number; bps: number }[] = [];
  estimator.onAvailableBitrate.subscribe((bps) =>
    events.push({ tMs: nowMs - kStartMs, bps }),
  );

  let nextExt = 1;
  let linkFreeAtMs = nowMs;
  const queue: { departMs: number; bytes: number }[] = [];
  const inFlight: InFlight[] = [];
  let reportedUpTo = 0;
  const pendingFeedback: {
    atMs: number;
    build: () => ReturnType<typeof wireTwccFeedback>;
  }[] = [];
  let mediaCredit = 0;
  let probePackets = 0;
  let fbCount = 0;

  const phaseEndBps: number[] = [];
  const queueDrops: number[] = [];
  const samples: { tMs: number; bps: number }[] = [];

  const queuedBytes = () => {
    while (queue.length > 0 && queue[0].departMs <= nowMs) queue.shift();
    return queue.reduce((sum, q) => sum + q.bytes, 0);
  };

  const recommended = () =>
    estimator.availableBitrate > 0
      ? estimator.availableBitrate
      : scenario.startBps;

  for (const phase of scenario.phases) {
    let drops = 0;
    const send = (bytes: number, probeClusterId?: number) => {
      const ext = nextExt++;
      estimator.rtpPacketSent(
        twccSentInfo(ext, bytes, nowMs, {
          probeClusterId,
          isProbation: probeClusterId !== undefined,
        }),
      );
      let arrivalMs: number | undefined;
      if (queuedBytes() + bytes > phase.link.queueLimitBytes) {
        drops++;
      } else {
        const departMs =
          Math.max(nowMs, linkFreeAtMs) +
          (bytes * 8 * 1000) / phase.link.capacityBps;
        linkFreeAtMs = departMs;
        queue.push({ departMs, bytes });
        if (rand() >= (phase.link.lossRate ?? 0)) {
          arrivalMs = departMs + phase.link.baseDelayMs;
        }
      }
      inFlight.push({ ext, arrivalMs });
    };

    const endMs = nowMs + phase.durationMs;
    for (; nowMs < endMs; nowMs++) {
      const elapsed = nowMs - kStartMs;
      if (
        estimator.processIntervalMs > 0 &&
        elapsed % estimator.processIntervalMs === 0
      ) {
        estimator.process(nowMs);
      }

      // Media at the source rate (token bucket, 1ms granularity).
      const rateBps = phase.source === "follow" ? recommended() : phase.source;
      mediaCredit += rateBps / 8 / 1000;
      while (mediaCredit >= packetBytes) {
        mediaCredit -= packetBytes;
        send(packetBytes);
      }

      // Probe padding while a cluster asks for it (at most 4 per ms).
      for (let i = 0; i < 4; i++) {
        if (!estimator.shouldTagProbePacket()) break;
        if (estimator.pendingProbePaddingPackets(kProbePacketBytes) <= 0) break;
        const reservation = estimator.reserveOutgoingProbe(nowMs);
        if (!reservation || reservation.nextSendTimeMs > nowMs) break;
        send(kProbePacketBytes, reservation.clusterId);
        probePackets++;
      }

      // Receiver: periodic TWCC over the contiguous range seen so far.
      if (elapsed % feedbackIntervalMs === 0) {
        let last = reportedUpTo;
        for (const p of inFlight) {
          if (
            p.ext > reportedUpTo &&
            p.arrivalMs !== undefined &&
            p.arrivalMs <= nowMs
          ) {
            last = Math.max(last, p.ext);
          }
        }
        if (last > reportedUpTo) {
          const window = inFlight.filter(
            (p) => p.ext > reportedUpTo && p.ext <= last,
          );
          const base = reportedUpTo + 1;
          const recvUs = window.map((p) =>
            p.arrivalMs !== undefined && p.arrivalMs <= nowMs
              ? Math.round(p.arrivalMs * 1000)
              : undefined,
          );
          reportedUpTo = last;
          const count = fbCount++ & 0xff;
          if (phase.feedback !== false) {
            pendingFeedback.push({
              atMs: nowMs + phase.link.baseDelayMs,
              build: () => wireTwccFeedback(base, recvUs, count),
            });
          }
          while (inFlight.length > 0 && inFlight[0].ext <= reportedUpTo) {
            inFlight.shift();
          }
        }
      }

      while (pendingFeedback.length > 0 && pendingFeedback[0].atMs <= nowMs) {
        estimator.receiveTWCC(pendingFeedback.shift()!.build());
      }

      if (elapsed % 100 === 0) {
        samples.push({ tMs: elapsed, bps: estimator.availableBitrate });
      }
    }
    phaseEndBps.push(estimator.availableBitrate);
    queueDrops.push(drops);
  }

  return { estimator, events, phaseEndBps, queueDrops, samples, probePackets };
}

/** Recommended bitrate at sim time `tMs` (last sample at or before it). */
export function bitrateAt(result: GccSimulationResult, tMs: number): number {
  let bps = 0;
  for (const s of result.samples) {
    if (s.tMs > tMs) break;
    bps = s.bps;
  }
  return bps;
}
