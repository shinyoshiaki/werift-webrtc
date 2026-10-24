Object.defineProperty(exports, "__esModule", { value: true });
exports.RtpMediaPacer =
  exports.RtpMediaClock =
  exports.RtpMediaTimeline =
    void 0;
const src_1 = require("../../../common/src");
const UINT32_MODULO = 4294967296;
/** Absorbs floating point noise when `now` lands exactly on a deadline. */
const SLOT_EPSILON = 1e-9;
/**
 * Pure, deterministic RTP media timeline.
 *
 * All values are computed absolutely from the frame index, so no error
 * accumulates no matter how long the timeline runs.
 */
class RtpMediaTimeline {
  constructor(options) {
    Object.defineProperty(this, "clockRate", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "frameSamples", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "frameDurationMs", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "initialTimestamp", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
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
      assertPositive("frameDurationMs", frameDurationMs);
      this.frameDurationMs = frameDurationMs;
      this.frameSamples = (frameDurationMs * clockRate) / 1000;
    }
    this.initialTimestamp = toUint32(
      Math.round(options.initialTimestamp ?? (0, src_1.random32)()),
    );
  }
  /** `round(N * frameSamples)`: samples elapsed from frame 0 to frame N. */
  elapsedSamples(frameIndex) {
    return Math.round(frameIndex * this.frameSamples);
  }
  /** `(initialTimestamp + elapsedSamples(N)) mod 2^32` */
  timestamp(frameIndex) {
    return toUint32(this.initialTimestamp + this.elapsedSamples(frameIndex));
  }
  /** `anchor.time + (N - anchor.frameIndex) * frameDurationMs` */
  deadline(anchor, frameIndex) {
    return (
      anchor.time + (frameIndex - anchor.frameIndex) * this.frameDurationMs
    );
  }
  /** Latest slot whose deadline has been reached at `now`. */
  latestFrameIndex(anchor, now) {
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
   * `skippedFrames` and `elapsedSamples` are counted from `lastFrameIndex`
   * (or from `baseFrameIndex` before the first tick), so a `nextFrameIndex`
   * moved forward (e.g. by `resume()`) is reported as skipped too.
   */
  resolveTick({
    anchor,
    nextFrameIndex,
    lastFrameIndex,
    baseFrameIndex = nextFrameIndex,
    now,
    stallPolicy = "skip",
  }) {
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
        this.elapsedSamples(lastFrameIndex ?? baseFrameIndex),
      skippedFrames:
        frameIndex -
        (lastFrameIndex !== undefined ? lastFrameIndex + 1 : baseFrameIndex),
      deadline,
      lateness: now - deadline,
    };
  }
}
exports.RtpMediaTimeline = RtpMediaTimeline;
const defaultScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
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
class RtpMediaClock {
  constructor(options) {
    Object.defineProperty(this, "timeline", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "onTick", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new src_1.Event(),
    });
    Object.defineProperty(this, "stallPolicy", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "now", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "scheduler", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "unref", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "signal", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "_state", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: "idle",
    });
    Object.defineProperty(this, "anchor", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { time: 0, frameIndex: 0 },
    });
    Object.defineProperty(this, "nextFrameIndex", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "_lastTick", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "timerHandle", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "handleAbort", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: () => {
        this.stop();
      },
    });
    Object.defineProperty(this, "handleTimer", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: () => {
        this.timerHandle = undefined;
        if (this._state !== "running") {
          return;
        }
        const now = this.now();
        const tick = this.timeline.resolveTick({
          anchor: this.anchor,
          nextFrameIndex: this.nextFrameIndex,
          lastFrameIndex: this._lastTick?.frameIndex,
          // the timeline starts at slot 0; keep counting from there even if
          // resume() moved nextFrameIndex before the first tick
          baseFrameIndex: 0,
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
      },
    });
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
  start(onTick) {
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
  resume(options = {}) {
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
    // re-anchor the origin to the resume time so that resume never bursts, and
    // resolve the resume tick from that slot so that "delay" honors the gap too
    this.anchor = { time: now, frameIndex };
    this.nextFrameIndex = frameIndex;
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
  schedule(delay) {
    const handle = this.scheduler.setTimeout(this.handleTimer, delay);
    if (this.unref) {
      handle?.unref?.();
    }
    this.timerHandle = handle;
  }
  clearTimer() {
    if (this.timerHandle !== undefined) {
      this.scheduler.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }
}
exports.RtpMediaClock = RtpMediaClock;
/**
 * Monotonic real-time pacer for frames with their own timestamps, such as
 * variable-frame-rate encoded video. Works both for sources that are read
 * ahead (demuxed files) and for streaming sources that deliver frames in real
 * time with jitter (live encoders, pipes, network ingest).
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
 * - For streaming sources, frames arriving early (bursts) wait for their
 *   deadline and frames arriving late are sent at once, so `delay` grows only
 *   up to the worst arrival lateness seen, never cumulatively. `latencyMs`
 *   reserves headroom for that jitter up front.
 * - `resume()` emits the next frame immediately if it became due while paused
 *   and re-anchors to it; the paused time is added to `delay`.
 * - `onTick` subscribers are invoked synchronously after the internal state has
 *   been updated. Returned promises are not awaited; use `queueLength` for
 *   backpressure on the producer side.
 */
class RtpMediaPacer {
  constructor(options) {
    Object.defineProperty(this, "clockRate", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "initialTimestamp", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "onTick", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new src_1.Event(),
    });
    Object.defineProperty(this, "now", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "scheduler", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "unref", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "signal", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "latencyMs", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "_state", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: "idle",
    });
    Object.defineProperty(this, "queue", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: [],
    });
    Object.defineProperty(this, "firstPts", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "lastPushedDts", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    /** maps a dts to a monotonic time; undefined until the first emission */
    Object.defineProperty(this, "anchor", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "frameIndex", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "_delay", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(this, "_lastTick", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "timerHandle", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "handleAbort", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: () => {
        this.stop();
      },
    });
    Object.defineProperty(this, "handleTimer", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: () => {
        this.timerHandle = undefined;
        const entry = this.queue[0];
        if (this._state !== "running" || !entry) {
          return;
        }
        const now = this.now();
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
        const tick = {
          frame: entry.frame,
          frameIndex: this.frameIndex,
          timestamp: toUint32(
            this.initialTimestamp + Math.round(entry.pts - this.firstPts),
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
      },
    });
    assertPositive("clockRate", options.clockRate);
    this.clockRate = options.clockRate;
    this.initialTimestamp = toUint32(
      Math.round(options.initialTimestamp ?? (0, src_1.random32)()),
    );
    this.latencyMs = options.latencyMs ?? 0;
    if (!Number.isFinite(this.latencyMs) || this.latencyMs < 0) {
      throw new RangeError("latencyMs must be a non-negative finite number");
    }
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
  push(frame, timing) {
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
    this.firstPts ?? (this.firstPts = pts);
    this.queue.push({ frame, pts, dts });
    if (this._state === "running" && this.timerHandle === undefined) {
      this.scheduleNext(this.now());
    }
  }
  start(onTick) {
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
  deadline(dts) {
    const anchor = this.anchor;
    return anchor.time + ((dts - anchor.dts) * 1000) / this.clockRate;
  }
  reanchor(time, dts) {
    if (this.anchor) {
      this._delay += time - this.deadline(dts);
    }
    this.anchor = { time, dts };
  }
  scheduleNext(now) {
    const next = this.queue[0];
    if (!next) {
      return;
    }
    // the first frame anchors the timeline, `latencyMs` after it is scheduled
    this.anchor ??
      (this.anchor = { time: now + this.latencyMs, dts: next.dts });
    const delay = Math.max(0, this.deadline(next.dts) - now);
    const handle = this.scheduler.setTimeout(this.handleTimer, delay);
    if (this.unref) {
      handle?.unref?.();
    }
    this.timerHandle = handle;
  }
  clearTimer() {
    if (this.timerHandle !== undefined) {
      this.scheduler.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }
}
exports.RtpMediaPacer = RtpMediaPacer;
function toUint32(value) {
  const mod = value % UINT32_MODULO;
  return mod < 0 ? mod + UINT32_MODULO : mod;
}
function assertPositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}
//# sourceMappingURL=mediaClock.js.map
