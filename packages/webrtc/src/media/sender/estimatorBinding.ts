import { milliTime } from "../../utils";
import type {
  BandwidthEstimator,
  ProbeClusterConfig,
} from "./bandwidthEstimator";

/** What the binding reports back to its {@link RTCRtpSender}. */
export type EstimatorBindingHooks = {
  /** The active estimator changed its recommended bitrate (bps). */
  onAvailableBitrate: (bps: number) => void;
  /** The active estimator activated a probe cluster. */
  onProbeClusterConfig: (cfg: ProbeClusterConfig) => void;
  /** After each process tick (pin GetPacingRates padding_rate). */
  onProcessTick: () => void;
  /** The sender is stopped: the process timer neither starts nor ticks. */
  isStopped: () => boolean;
};

/**
 * The send-side bandwidth estimator of one {@link RTCRtpSender} and
 * everything tied to its lifetime: the event bridges to the sender, the
 * process timer, and the **generation**.
 *
 * The generation is bumped whenever the estimator is replaced, reset for a
 * new transport, or the sender stops. A send or padding drain captures it at
 * start and drops its estimator delivery when it no longer matches, so a
 * packet planned under the old estimator cannot pollute the new clean one or
 * revive a disposed probe controller. {@link generationSignal} aborts at the
 * same moment to release waits running at the old estimator's rate.
 */
export class EstimatorBinding {
  private current: BandwidthEstimator;
  private _generation = 0;
  private generationCancel = new AbortController();
  private unsubscribeAvailableBitrate?: () => void;
  private unsubscribeProbeClusterConfig?: () => void;
  /** Interval from {@link BandwidthEstimator.processIntervalMs} (0 = none). */
  private processTimer?: ReturnType<typeof setInterval>;

  constructor(
    initial: BandwidthEstimator,
    private readonly hooks: EstimatorBindingHooks,
  ) {
    this.current = initial;
    this.bind(initial);
  }

  get estimator(): BandwidthEstimator {
    return this.current;
  }

  get generation() {
    return this._generation;
  }

  /** Aborted on the next generation bump. */
  get generationSignal(): AbortSignal {
    return this.generationCancel.signal;
  }

  /** Invalidate sends planned under the current estimator and release their waits. */
  bumpGeneration() {
    this._generation++;
    this.generationCancel.abort();
    this.generationCancel = new AbortController();
  }

  /**
   * Make `impl` the active estimator with a clean state: bump the
   * generation, release the previous instance (`dispose()`, else `reset()`)
   * and always `reset()` `impl`, so a previously used instance does not merge
   * old state. The same instance is only reset.
   */
  replace(impl: BandwidthEstimator) {
    this.bumpGeneration();
    if (impl === this.current) {
      impl.reset?.();
      return;
    }
    this.unbind();
    release(this.current);
    impl.reset?.();
    this.current = impl;
    this.bind(impl);
  }

  /**
   * A new DTLS transport has its own transport-wide sequence space and path
   * (pin `OnNetworkRouteChanged` resets the controller): drop the path state
   * and keep app-configured constraints
   * ({@link BandwidthEstimator.resetNetworkRoute}, else `reset()`).
   */
  resetForNewRoute() {
    this.bumpGeneration();
    const estimator = this.current;
    if (estimator.resetNetworkRoute) estimator.resetNetworkRoute();
    else estimator.reset?.();
  }

  /**
   * pin `OnNetworkAvailability` — initial probes wait until DTLS can send.
   * Lightweight / disabled no-op `setNetworkAvailable`.
   */
  syncNetworkAvailability(connected: boolean) {
    this.current.setNetworkAvailable(connected);
  }

  /**
   * (Re)start the process timer for the active estimator (pin
   * `GoogCcNetworkControllerFactory::GetProcessInterval`).
   */
  syncProcessTimer() {
    this.stopProcessTimer();
    if (this.hooks.isStopped()) return;
    const intervalMs = this.current.processIntervalMs;
    if (!(intervalMs > 0)) return;
    const timer = setInterval(() => {
      if (this.hooks.isStopped()) return;
      this.current.process(milliTime());
      this.hooks.onProcessTick();
    }, intervalMs);
    timer.unref?.();
    this.processTimer = timer;
  }

  /** Sender stop: no timer, no bridges, estimator released. */
  close() {
    this.stopProcessTimer();
    this.unbind();
    release(this.current);
  }

  private stopProcessTimer() {
    if (this.processTimer !== undefined) {
      clearInterval(this.processTimer);
      this.processTimer = undefined;
    }
  }

  private bind(impl: BandwidthEstimator) {
    this.unsubscribeAvailableBitrate?.();
    this.unsubscribeAvailableBitrate = impl.onAvailableBitrate.subscribe(
      (bps) => this.hooks.onAvailableBitrate(bps),
    ).unSubscribe;

    this.unsubscribeProbeClusterConfig?.();
    this.unsubscribeProbeClusterConfig = impl.onProbeClusterConfig.subscribe(
      (cfg) => this.hooks.onProbeClusterConfig(cfg),
    ).unSubscribe;
  }

  private unbind() {
    this.unsubscribeAvailableBitrate?.();
    this.unsubscribeAvailableBitrate = undefined;
    this.unsubscribeProbeClusterConfig?.();
    this.unsubscribeProbeClusterConfig = undefined;
  }
}

function release(estimator: BandwidthEstimator) {
  if (estimator.dispose) {
    estimator.dispose();
  } else {
    estimator.reset?.();
  }
}
