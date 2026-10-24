import { Event } from "../../../common/src";
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
export declare class RtpMediaTimeline {
  readonly clockRate: number;
  readonly frameSamples: number;
  readonly frameDurationMs: number;
  readonly initialTimestamp: number;
  constructor(options: RtpMediaTimelineOptions);
  /** `round(N * frameSamples)`: samples elapsed from frame 0 to frame N. */
  elapsedSamples(frameIndex: number): number;
  /** `(initialTimestamp + elapsedSamples(N)) mod 2^32` */
  timestamp(frameIndex: number): number;
  /** `anchor.time + (N - anchor.frameIndex) * frameDurationMs` */
  deadline(anchor: RtpMediaTimelineAnchor, frameIndex: number): number;
  /** Latest slot whose deadline has been reached at `now`. */
  latestFrameIndex(anchor: RtpMediaTimelineAnchor, now: number): number;
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
    baseFrameIndex,
    now,
    stallPolicy,
  }: {
    anchor: RtpMediaTimelineAnchor;
    nextFrameIndex: number;
    /** Frame index of the previous tick, if any. */
    lastFrameIndex?: number;
    /**
     * First slot of the timeline, used as the counting origin while there is no
     * previous tick. Default: `nextFrameIndex`.
     */
    baseFrameIndex?: number;
    now: number;
    stallPolicy?: RtpMediaClockStallPolicy;
  }): RtpMediaClockTick | undefined;
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
export declare class RtpMediaClock {
  readonly timeline: RtpMediaTimeline;
  readonly onTick: Event<[RtpMediaClockTick]>;
  readonly stallPolicy: RtpMediaClockStallPolicy;
  private readonly now;
  private readonly scheduler;
  private readonly unref;
  private readonly signal?;
  private _state;
  private anchor;
  private nextFrameIndex;
  private _lastTick?;
  private timerHandle?;
  constructor(options: RtpMediaClockOptions);
  get state(): RtpMediaClockState;
  get clockRate(): number;
  /** The most recently emitted tick. */
  get lastTick(): RtpMediaClockTick | undefined;
  /** RTP timestamp of the latest tick, or of frame 0 before the first tick. */
  get timestamp(): number;
  start(onTick?: (tick: RtpMediaClockTick) => void): void;
  pause(): void;
  resume(options?: RtpMediaClockResumeOptions): void;
  stop(): void;
  private handleAbort;
  private schedule;
  private clearTimer;
  private handleTimer;
}
export interface RtpMediaPacerOptions {
  /** RTP clock rate in Hz (e.g. 90000 for video). */
  clockRate: number;
  /** RTP timestamp of the first pushed frame's `pts`. Default: random32(). */
  initialTimestamp?: number;
  /**
   * Initial playout delay (ms) of the first frame. For streaming sources it
   * absorbs arrival jitter / bursts up to this amount without re-anchoring.
   * Default: 0.
   */
  latencyMs?: number;
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
export declare class RtpMediaPacer<T = Buffer> {
  readonly clockRate: number;
  readonly initialTimestamp: number;
  readonly onTick: Event<[RtpMediaPacerTick<T>]>;
  private readonly now;
  private readonly scheduler;
  private readonly unref;
  private readonly signal?;
  private readonly latencyMs;
  private _state;
  private queue;
  private firstPts?;
  private lastPushedDts?;
  /** maps a dts to a monotonic time; undefined until the first emission */
  private anchor?;
  private frameIndex;
  private _delay;
  private _lastTick?;
  private timerHandle?;
  constructor(options: RtpMediaPacerOptions);
  get state(): RtpMediaClockState;
  /** Frames pushed but not emitted yet. */
  get queueLength(): number;
  /** The most recently emitted tick. */
  get lastTick(): RtpMediaPacerTick<T> | undefined;
  /** Total time (ms) the timeline has been shifted so far. */
  get delay(): number;
  /** Queues a frame. Frames may be pushed before `start()`. */
  push(frame: T, timing: RtpMediaPacerFrameTiming): void;
  start(onTick?: (tick: RtpMediaPacerTick<T>) => void): void;
  pause(): void;
  resume(): void;
  stop(): void;
  private handleAbort;
  private deadline;
  private reanchor;
  private scheduleNext;
  private clearTimer;
  private handleTimer;
}
