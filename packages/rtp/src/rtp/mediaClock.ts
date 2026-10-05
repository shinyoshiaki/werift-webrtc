import { Event, random32 } from "../../../common/src";

const UINT32_MODULO = 0x1_0000_0000;
/** Absorbs floating point noise when `now` lands exactly on a deadline. */
const SLOT_EPSILON = 1e-9;

export interface RtpMediaTimelineOptions {
  /** RTP clock rate in Hz (e.g. 48000 for Opus, 90000 for video). */
  clockRate: number;
  /**
   * Samples per frame. May be fractional (e.g. 90000 / 29.97).
   * Exactly one of `frameSamples` / `frameDurationMs` must be given.
   */
  frameSamples?: number;
  /** Frame duration in milliseconds. May be fractional. */
  frameDurationMs?: number;
  /** RTP timestamp of frame 0. Default: random32(). */
  initialTimestamp?: number;
}

/** Wall-clock anchor that maps a monotonic time to a frame index. */
export interface RtpMediaTimelineAnchor {
  /** Monotonic time (ms) of `frameIndex`'s deadline. */
  time: number;
  frameIndex: number;
}

export interface RtpMediaClockTick {
  /** Slot number N of this tick. */
  frameIndex: number;
  /** RTP timestamp of the slot (uint32, wrapped). */
  timestamp: number;
  /** Samples elapsed since the previous tick, including skipped slots. */
  elapsedSamples: number;
  /** Slots that were skipped instead of being emitted (normally 0). */
  skippedFrames: number;
  /** Scheduled monotonic time (ms) of this slot. */
  deadline: number;
  /** `now - deadline` in ms. */
  lateness: number;
}

/**
 * Pure, deterministic RTP media timeline.
 *
 * All values are computed absolutely from the frame index, so no error
 * accumulates no matter how long the timeline runs.
 */
export class RtpMediaTimeline {
  readonly clockRate: number;
  readonly frameSamples: number;
  readonly frameDurationMs: number;
  readonly initialTimestamp: number;

  constructor(options: RtpMediaTimelineOptions) {
    const { clockRate, frameSamples, frameDurationMs } = options;
    assertPositive("clockRate", clockRate);
    if ((frameSamples === undefined) === (frameDurationMs === undefined)) {
      throw new TypeError(
        "exactly one of frameSamples or frameDurationMs must be specified",
      );
    }
    this.clockRate = clockRate;
    if (frameSamples !== undefined) {
      assertPositive("frameSamples", frameSamples);
      this.frameSamples = frameSamples;
      this.frameDurationMs = (frameSamples * 1000) / clockRate;
    } else {
      assertPositive("frameDurationMs", frameDurationMs!);
      this.frameDurationMs = frameDurationMs!;
      this.frameSamples = (frameDurationMs! * clockRate) / 1000;
    }
    this.initialTimestamp = toUint32(
      Math.round(options.initialTimestamp ?? random32()),
    );
  }

  /** `round(N * frameSamples)`: samples elapsed from frame 0 to frame N. */
  elapsedSamples(frameIndex: number) {
    return Math.round(frameIndex * this.frameSamples);
  }

  /** `(initialTimestamp + elapsedSamples(N)) mod 2^32` */
  timestamp(frameIndex: number) {
    return toUint32(this.initialTimestamp + this.elapsedSamples(frameIndex));
  }

  /** `anchor.time + (N - anchor.frameIndex) * frameDurationMs` */
  deadline(anchor: RtpMediaTimelineAnchor, frameIndex: number) {
    return (
      anchor.time + (frameIndex - anchor.frameIndex) * this.frameDurationMs
    );
  }

  /** Latest slot whose deadline has been reached at `now`. */
  latestFrameIndex(anchor: RtpMediaTimelineAnchor, now: number) {
    return (
      anchor.frameIndex +
      Math.floor((now - anchor.time) / this.frameDurationMs + SLOT_EPSILON)
    );
  }

  /**
   * Resolves the tick to emit at `now`.
   *
   * Returns `undefined` when the deadline of `nextFrameIndex` has not been
   * reached yet. When several slots have elapsed, only the latest reached slot
   * is returned and the slots in between are reported as `skippedFrames`.
   */
  resolveTick({
    anchor,
    nextFrameIndex,
    lastFrameIndex,
    now,
  }: {
    anchor: RtpMediaTimelineAnchor;
    nextFrameIndex: number;
    /** Frame index of the previous tick, if any. */
    lastFrameIndex?: number;
    now: number;
  }): RtpMediaClockTick | undefined {
    const frameIndex = this.latestFrameIndex(anchor, now);
    if (frameIndex < nextFrameIndex) {
      return undefined;
    }
    const deadline = this.deadline(anchor, frameIndex);
    return {
      frameIndex,
      timestamp: this.timestamp(frameIndex),
      elapsedSamples:
        this.elapsedSamples(frameIndex) -
        this.elapsedSamples(lastFrameIndex ?? nextFrameIndex),
      skippedFrames: frameIndex - nextFrameIndex,
      deadline,
      lateness: now - deadline,
    };
  }
}

export interface RtpMediaClockScheduler {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RtpMediaClockOptions extends RtpMediaTimelineOptions {
  /** Monotonic time source in ms. Default: `performance.now()`. */
  now?: () => number;
  /** Timer implementation. Default: global setTimeout / clearTimeout. */
  scheduler?: RtpMediaClockScheduler;
  /** Call `unref()` on timer handles (Node.js only). Default: false. */
  unref?: boolean;
  /** Aborting the signal is equivalent to `stop()`. */
  signal?: AbortSignal;
}

export interface RtpMediaClockResumeOptions {
  /**
   * `false` (default): the paused wall-clock time is reflected as a timestamp
   * gap, the same as a scheduler stall.
   * `true`: the pause is collapsed and the timeline advances by one frame.
   */
  continuous?: boolean;
}

export type RtpMediaClockState = "idle" | "running" | "paused" | "stopped";

const defaultScheduler: RtpMediaClockScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Monotonic real-time RTP media clock / pacer.
 *
 * - Each slot N is scheduled at the absolute deadline
 *   `origin + N * frameDurationMs`, so timer lateness never accumulates.
 * - When the event loop stalls past several deadlines, `onTick` fires once for
 *   the latest reached slot; the slots in between are reported via
 *   `skippedFrames` and appear as a timestamp gap. Late ticks are never burst.
 * - `onTick` subscribers are invoked synchronously after the internal state
 *   (including the next timer) has been updated. Returned promises are not
 *   awaited; backpressure is out of scope.
 * - `resume()` re-anchors the origin to the resume time and emits a tick
 *   immediately. By default the paused time is reflected as a timestamp gap;
 *   pass `{ continuous: true }` to collapse it.
 *
 * This is an opt-in utility for media sources. `RTCRtpSender.sendRtp()` never
 * rewrites RTP timestamps based on send time.
 */
export class RtpMediaClock {
  readonly timeline: RtpMediaTimeline;
  readonly onTick = new Event<[RtpMediaClockTick]>();

  private readonly now: () => number;
  private readonly scheduler: RtpMediaClockScheduler;
  private readonly unref: boolean;
  private readonly signal?: AbortSignal;

  private _state: RtpMediaClockState = "idle";
  private anchor: RtpMediaTimelineAnchor = { time: 0, frameIndex: 0 };
  private nextFrameIndex = 0;
  private _lastTick?: RtpMediaClockTick;
  private timerHandle?: unknown;

  constructor(options: RtpMediaClockOptions) {
    this.timeline = new RtpMediaTimeline(options);
    this.now = options.now ?? (() => performance.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.unref = options.unref ?? false;
    this.signal = options.signal;
  }

  get state() {
    return this._state;
  }

  get clockRate() {
    return this.timeline.clockRate;
  }

  /** The most recently emitted tick. */
  get lastTick() {
    return this._lastTick;
  }

  /** RTP timestamp of the latest tick, or of frame 0 before the first tick. */
  get timestamp() {
    return this._lastTick?.timestamp ?? this.timeline.timestamp(0);
  }

  start(onTick?: (tick: RtpMediaClockTick) => void) {
    if (this._state !== "idle") {
      throw new Error(`RtpMediaClock cannot start from state ${this._state}`);
    }
    if (onTick) {
      this.onTick.subscribe(onTick);
    }
    if (this.signal?.aborted) {
      this.stop();
      return;
    }
    this.signal?.addEventListener("abort", this.handleAbort);

    this._state = "running";
    this.anchor = { time: this.now(), frameIndex: 0 };
    this.nextFrameIndex = 0;
    this.schedule(0);
  }

  pause() {
    if (this._state !== "running") {
      return;
    }
    this._state = "paused";
    this.clearTimer();
  }

  resume(options: RtpMediaClockResumeOptions = {}) {
    if (this._state !== "paused") {
      return;
    }
    const now = this.now();
    const frameIndex = options.continuous
      ? this.nextFrameIndex
      : Math.max(
          this.nextFrameIndex,
          this.timeline.latestFrameIndex(this.anchor, now),
        );
    // re-anchor the origin to the resume time so that resume never bursts
    this.anchor = { time: now, frameIndex };
    this._state = "running";
    this.schedule(0);
  }

  stop() {
    if (this._state === "stopped") {
      return;
    }
    this._state = "stopped";
    this.clearTimer();
    this.signal?.removeEventListener("abort", this.handleAbort);
    this.onTick.complete();
  }

  private handleAbort = () => {
    this.stop();
  };

  private schedule(delay: number) {
    const handle = this.scheduler.setTimeout(this.handleTimer, delay);
    if (this.unref) {
      (handle as { unref?: () => void } | undefined)?.unref?.();
    }
    this.timerHandle = handle;
  }

  private clearTimer() {
    if (this.timerHandle !== undefined) {
      this.scheduler.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }

  private handleTimer = () => {
    this.timerHandle = undefined;
    if (this._state !== "running") {
      return;
    }
    const now = this.now();
    const tick = this.timeline.resolveTick({
      anchor: this.anchor,
      nextFrameIndex: this.nextFrameIndex,
      lastFrameIndex: this._lastTick?.frameIndex,
      now,
    });
    if (!tick) {
      // timer fired early
      this.schedule(
        Math.max(
          0,
          this.timeline.deadline(this.anchor, this.nextFrameIndex) - now,
        ),
      );
      return;
    }

    // commit state and the next timer first so that a throwing subscriber
    // cannot corrupt the clock
    this._lastTick = tick;
    this.nextFrameIndex = tick.frameIndex + 1;
    this.schedule(
      Math.max(
        0,
        this.timeline.deadline(this.anchor, this.nextFrameIndex) - now,
      ),
    );

    this.onTick.execute(tick);
  };
}

function toUint32(value: number) {
  const mod = value % UINT32_MODULO;
  return mod < 0 ? mod + UINT32_MODULO : mod;
}

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}
