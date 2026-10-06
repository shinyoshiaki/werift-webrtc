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
   * reached yet. When several slots have elapsed, `stallPolicy: "skip"`
   * (default) returns only the latest reached slot and reports the slots in
   * between as `skippedFrames`; `"delay"` returns `nextFrameIndex` with its
   * original deadline, so `lateness` shows how far behind the clock is.
   */
  resolveTick({
    anchor,
    nextFrameIndex,
    lastFrameIndex,
    now,
    stallPolicy = "skip",
  }: {
    anchor: RtpMediaTimelineAnchor;
    nextFrameIndex: number;
    /** Frame index of the previous tick, if any. */
    lastFrameIndex?: number;
    now: number;
    stallPolicy?: RtpMediaClockStallPolicy;
  }): RtpMediaClockTick | undefined {
    const latest = this.latestFrameIndex(anchor, now);
    if (latest < nextFrameIndex) {
      return undefined;
    }
    const frameIndex = stallPolicy === "delay" ? nextFrameIndex : latest;
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

/**
 * What to do when the clock falls behind by one frame or more.
 *
 * - `"skip"`: jump to the latest reached slot. The slots in between are
 *   reported as `skippedFrames` and appear as a timestamp gap. RTP time stays
 *   aligned with real time. Suited to audio and to live video that encodes the
 *   latest captured frame on each tick.
 * - `"delay"`: never skip a slot. The late slot is emitted immediately and the
 *   timeline is re-anchored to `now`, so the stall is absorbed as added latency
 *   instead of a gap or a burst. Suited to already-encoded video (or any source
 *   where every frame must be sent) at a constant frame rate.
 */
export type RtpMediaClockStallPolicy = "skip" | "delay";

export interface RtpMediaClockOptions extends RtpMediaTimelineOptions {
  /** Default: `"skip"`. */
  stallPolicy?: RtpMediaClockStallPolicy;
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
   * `false`: the paused wall-clock time is reflected as a timestamp gap, the
   * same as a scheduler stall.
   * `true`: the pause is collapsed and the timeline advances by one frame.
   *
   * Default: `false` for `stallPolicy: "skip"`, `true` for `"delay"`.
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
 * - When the event loop stalls past several deadlines, `onTick` fires once.
 *   With `stallPolicy: "skip"` (default) it fires for the latest reached slot;
 *   the slots in between are reported via `skippedFrames` and appear as a
 *   timestamp gap. With `"delay"` it fires for the next slot and re-anchors
 *   the timeline, so no slot is skipped. Late ticks are never burst.
 * - `onTick` subscribers are invoked synchronously after the internal state
 *   (including the next timer) has been updated. Returned promises are not
 *   awaited; backpressure is out of scope.
 * - `resume()` re-anchors the origin to the resume time and emits a tick
 *   immediately. With `"skip"` the paused time is reflected as a timestamp gap
 *   by default; pass `{ continuous: true }` to collapse it (default for
 *   `"delay"`).
 *
 * This is an opt-in utility for media sources. `RTCRtpSender.sendRtp()` never
 * rewrites RTP timestamps based on send time.
 */
export class RtpMediaClock {
  readonly timeline: RtpMediaTimeline;
  readonly onTick = new Event<[RtpMediaClockTick]>();
  readonly stallPolicy: RtpMediaClockStallPolicy;

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
    this.stallPolicy = options.stallPolicy ?? "skip";
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
    const continuous = options.continuous ?? this.stallPolicy === "delay";
    const frameIndex = continuous
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
      stallPolicy: this.stallPolicy,
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
    if (
      this.stallPolicy === "delay" &&
      tick.lateness >= this.timeline.frameDurationMs
    ) {
      // "delay" policy: absorb the stall as latency instead of bursting
      this.anchor = { time: now, frameIndex: tick.frameIndex };
    }
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

export interface RtpMediaPacerOptions {
  /** RTP clock rate in Hz (e.g. 90000 for video). */
  clockRate: number;
  /** RTP timestamp of the first pushed frame's `pts`. Default: random32(). */
  initialTimestamp?: number;
  /** Monotonic time source in ms. Default: `performance.now()`. */
  now?: () => number;
  /** Timer implementation. Default: global setTimeout / clearTimeout. */
  scheduler?: RtpMediaClockScheduler;
  /** Call `unref()` on timer handles (Node.js only). Default: false. */
  unref?: boolean;
  /** Aborting the signal is equivalent to `stop()`. */
  signal?: AbortSignal;
}

export interface RtpMediaPacerFrameTiming {
  /**
   * Presentation time in `clockRate` units (e.g. container PTS rescaled to
   * 90 kHz). Becomes the RTP timestamp. May be fractional.
   */
  pts: number;
  /**
   * Decode time in `clockRate` units; frames are paced by it and must be pushed
   * in non-decreasing `dts` order. Default: `pts` (no B-frames).
   */
  dts?: number;
}

export interface RtpMediaPacerTick<T> {
  frame: T;
  /** Number of frames emitted before this one. */
  frameIndex: number;
  /** RTP timestamp derived from `pts` (uint32, wrapped). */
  timestamp: number;
  pts: number;
  dts: number;
  /** Scheduled monotonic time (ms) of this frame. */
  deadline: number;
  /** `now - deadline` in ms. */
  lateness: number;
  /** Total time (ms) the timeline has been shifted by stalls and pauses. */
  delay: number;
}

/**
 * Monotonic real-time pacer for frames with their own timestamps, such as
 * variable-frame-rate encoded video.
 *
 * - Frame k is emitted at the absolute deadline
 *   `anchor.time + (dts(k) - anchor.dts) * 1000 / clockRate`, so timer
 *   lateness never accumulates. The RTP timestamp is
 *   `initialTimestamp + (pts(k) - pts(first frame))`, which keeps the source's
 *   frame spacing (including B-frame reordering).
 * - Frames are never skipped. When the emitted frame and the next queued frame
 *   are both overdue (a stall, or a producer that pushes a late batch), only
 *   the emitted frame is sent and the timeline is re-anchored to `now`, so the
 *   stall becomes added latency (`delay`) instead of a burst. A frame pushed
 *   after its deadline while the queue is empty is emitted immediately.
 * - `resume()` emits the next frame immediately if it became due while paused
 *   and re-anchors to it; the paused time is added to `delay`.
 * - `onTick` subscribers are invoked synchronously after the internal state has
 *   been updated. Returned promises are not awaited; use `queueLength` for
 *   backpressure on the producer side.
 */
export class RtpMediaPacer<T = Buffer> {
  readonly clockRate: number;
  readonly initialTimestamp: number;
  readonly onTick = new Event<[RtpMediaPacerTick<T>]>();

  private readonly now: () => number;
  private readonly scheduler: RtpMediaClockScheduler;
  private readonly unref: boolean;
  private readonly signal?: AbortSignal;

  private _state: RtpMediaClockState = "idle";
  private queue: { frame: T; pts: number; dts: number }[] = [];
  private firstPts?: number;
  private lastPushedDts?: number;
  /** maps a dts to a monotonic time; undefined until the first emission */
  private anchor?: { time: number; dts: number };
  private frameIndex = 0;
  private _delay = 0;
  private _lastTick?: RtpMediaPacerTick<T>;
  private timerHandle?: unknown;

  constructor(options: RtpMediaPacerOptions) {
    assertPositive("clockRate", options.clockRate);
    this.clockRate = options.clockRate;
    this.initialTimestamp = toUint32(
      Math.round(options.initialTimestamp ?? random32()),
    );
    this.now = options.now ?? (() => performance.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.unref = options.unref ?? false;
    this.signal = options.signal;
  }

  get state() {
    return this._state;
  }

  /** Frames pushed but not emitted yet. */
  get queueLength() {
    return this.queue.length;
  }

  /** The most recently emitted tick. */
  get lastTick() {
    return this._lastTick;
  }

  /** Total time (ms) the timeline has been shifted so far. */
  get delay() {
    return this._delay;
  }

  /** Queues a frame. Frames may be pushed before `start()`. */
  push(frame: T, timing: RtpMediaPacerFrameTiming) {
    if (this._state === "stopped") {
      throw new Error("RtpMediaPacer is stopped");
    }
    const pts = timing.pts;
    const dts = timing.dts ?? pts;
    if (!Number.isFinite(pts) || !Number.isFinite(dts)) {
      throw new RangeError("pts and dts must be finite numbers");
    }
    if (this.lastPushedDts !== undefined && dts < this.lastPushedDts) {
      throw new RangeError("frames must be pushed in non-decreasing dts order");
    }
    this.lastPushedDts = dts;
    this.firstPts ??= pts;
    this.queue.push({ frame, pts, dts });
    if (this._state === "running" && this.timerHandle === undefined) {
      this.scheduleNext(this.now());
    }
  }

  start(onTick?: (tick: RtpMediaPacerTick<T>) => void) {
    if (this._state !== "idle") {
      throw new Error(`RtpMediaPacer cannot start from state ${this._state}`);
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
    if (this.queue.length > 0) {
      this.scheduleNext(this.now());
    }
  }

  pause() {
    if (this._state !== "running") {
      return;
    }
    this._state = "paused";
    this.clearTimer();
  }

  resume() {
    if (this._state !== "paused") {
      return;
    }
    this._state = "running";
    const now = this.now();
    const next = this.queue[0];
    if (next && this.anchor && this.deadline(next.dts) < now) {
      // the paused time becomes latency: the next frame is due now, no burst
      this.reanchor(now, next.dts);
    }
    this.scheduleNext(now);
  }

  stop() {
    if (this._state === "stopped") {
      return;
    }
    this._state = "stopped";
    this.clearTimer();
    this.queue = [];
    this.signal?.removeEventListener("abort", this.handleAbort);
    this.onTick.complete();
  }

  private handleAbort = () => {
    this.stop();
  };

  private deadline(dts: number) {
    const anchor = this.anchor!;
    return anchor.time + ((dts - anchor.dts) * 1000) / this.clockRate;
  }

  private reanchor(time: number, dts: number) {
    if (this.anchor) {
      this._delay += time - this.deadline(dts);
    }
    this.anchor = { time, dts };
  }

  private scheduleNext(now: number) {
    const next = this.queue[0];
    if (!next) {
      return;
    }
    const delay = this.anchor ? Math.max(0, this.deadline(next.dts) - now) : 0;
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
    const entry = this.queue[0];
    if (this._state !== "running" || !entry) {
      return;
    }
    const now = this.now();
    if (!this.anchor) {
      this.anchor = { time: now, dts: entry.dts };
    }
    const deadline = this.deadline(entry.dts);
    if (now < deadline - SLOT_EPSILON) {
      // timer fired early
      this.scheduleNext(now);
      return;
    }
    this.queue.shift();
    const next = this.queue[0];
    // stall: the following frame is overdue too -> absorb as latency
    const stalled = next !== undefined && this.deadline(next.dts) <= now;

    const tick: RtpMediaPacerTick<T> = {
      frame: entry.frame,
      frameIndex: this.frameIndex,
      timestamp: toUint32(
        this.initialTimestamp + Math.round(entry.pts - this.firstPts!),
      ),
      pts: entry.pts,
      dts: entry.dts,
      deadline,
      lateness: now - deadline,
      delay: 0,
    };

    // commit state and the next timer first so that a throwing subscriber
    // cannot corrupt the pacer
    if (stalled) {
      // plain timer lateness keeps the anchor and therefore never drifts
      this.reanchor(now, entry.dts);
    }
    tick.delay = this._delay;
    this.frameIndex++;
    this._lastTick = tick;
    this.scheduleNext(now);

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
