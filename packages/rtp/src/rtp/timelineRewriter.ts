import { Event } from "../../../common/src";
import { RtpContinuity } from "./continuity";
import { isPaddingOnlyRtpPacket, type RtpPacket } from "./rtp";

/**
 * How {@link RtpTimelineRewriter} chooses the output timestamp increment
 * between the last packet of the old source and the first packet of the new one.
 *
 * - `number`: that fixed increment (for example `3000` for 30 fps video at 90 kHz).
 * - `"lastDelta"`: the last positive timestamp increment seen on the stream
 *   (the frame / packet interval of the old source), or
 *   {@link RtpTimelineRewriterOptions.defaultTimestampStep} when none was seen yet.
 * - `"wallClock"`: the time between the last packet of the old source and the
 *   first packet of the new one, times `clockRate / 1000`
 *   (requires {@link RtpTimelineRewriterOptions.clockRate}). The reconnect time
 *   becomes media time, so separate audio / video rewriters keep their relative
 *   position (A/V sync). `"lastDelta"` / a fixed number advance audio and video
 *   by different amounts, so their relative offset can change at each switch.
 * - `"auto"` (default): `"wallClock"` when `clockRate` is set, otherwise `"lastDelta"`.
 *
 * Every mode advances the timestamp by at least 1.
 */
export type RtpTimestampStepMode = number | "lastDelta" | "wallClock" | "auto";

export interface RtpTimelineRewriterOptions {
  /** RTP clock rate of the stream in Hz (90000 for video). Needed by `"wallClock"`. */
  clockRate?: number;
  /** Timestamp increment at a source switch. Default `"auto"`. */
  timestampStep?: RtpTimestampStepMode;
  /** Increment used by `"lastDelta"` before any increment was seen. Default 1. */
  defaultTimestampStep?: number;
  /** Fixed output SSRC (for example the downstream SRTP SSRC). Default: keep the input SSRC. */
  ssrc?: number;
  /** Fixed output payload type. Default: keep the input payload type. */
  payloadType?: number;
  /**
   * Treat a change of the input SSRC as a source switch, like a new `source`
   * key. Late packets of the previous SSRC are then dropped. Default true.
   * Set false only when the input SSRC changes without a timeline change.
   */
  switchOnSsrcChange?: boolean;
  /**
   * Rewrite the header of the given packet instead of a clone. Default false:
   * received packets (`MediaStreamTrack.onReceiveRtp`) are shared by every
   * subscriber and must not be changed.
   */
  inPlace?: boolean;
  /** Monotonic clock in milliseconds. Default `performance.now()`. For tests. */
  now?: () => number;
}

/** Notified when output continues from a previous source. */
export interface RtpTimelineSwitch {
  /** `source` key of the new source (undefined when keys are not used). */
  source: unknown;
  /** Input SSRC of the new source. */
  inputSsrc: number;
  /** Output sequence number of the first packet of the new source. */
  sequenceNumber: number;
  /** Output timestamp of the first packet of the new source. */
  timestamp: number;
  /** Timestamp increment applied across the switch. */
  timestampStep: number;
}

/**
 * Why {@link RtpTimelineRewriter.rewrite} dropped a packet.
 * - `staleSource`: the packet belongs to a source that was already replaced.
 * - `beforeSourceStart`: the packet is older (by sequence number) than the
 *   first packet of the current source, so its output would go back to or
 *   before the output of the previous source.
 * @enum
 */
export const RtpTimelineDropReason = {
  staleSource: "staleSource",
  beforeSourceStart: "beforeSourceStart",
} as const;
/** @enum */
export type RtpTimelineDropReason =
  (typeof RtpTimelineDropReason)[keyof typeof RtpTimelineDropReason];

interface RetiredEntry {
  /** every SSRC of the source key is retired. */
  all: boolean;
  ssrcs: Set<number>;
}

/**
 * Replaced sources. Entries are never evicted, so a very old packet can never
 * be mistaken for a new source and retire the current one. Object keys are held
 * weakly; primitive keys cost a few bytes per switch.
 */
class RetiredSources {
  private readonly primitive = new Map<unknown, RetiredEntry>();
  private readonly objects = new WeakMap<object, RetiredEntry>();

  private static isObject(key: unknown): key is object {
    return (
      (typeof key === "object" && key !== null) || typeof key === "function"
    );
  }

  private get(key: unknown) {
    return RetiredSources.isObject(key)
      ? this.objects.get(key)
      : this.primitive.get(key);
  }

  add(key: unknown, ssrc?: number) {
    let entry = this.get(key);
    if (!entry) {
      entry = { all: false, ssrcs: new Set() };
      if (RetiredSources.isObject(key)) this.objects.set(key, entry);
      else this.primitive.set(key, entry);
    }
    if (ssrc === undefined) entry.all = true;
    else entry.ssrcs.add(ssrc);
  }

  has(key: unknown, ssrc: number, switchOnSsrc: boolean) {
    const entry = this.get(key);
    if (!entry) return false;
    return entry.all || (switchOnSsrc && entry.ssrcs.has(ssrc));
  }
}

/** Signed distance a - b of two 16-bit sequence numbers. */
const seqDiff = (a: number, b: number) => ((a - b) << 16) >> 16;
/** Signed distance a - b of two 32-bit timestamps. */
const tsDiff = (a: number, b: number) => (a - b) | 0;

/**
 * Keeps one continuous downstream RTP timeline (sequence number / timestamp,
 * optionally SSRC / payload type) while the upstream RTP source is replaced,
 * for example when an upstream WebRTC connection is recreated and its RTP is
 * forwarded to a long-lived downstream RTP / SRTP session.
 *
 * - The first source is output unchanged (except the fixed `ssrc` / `payloadType`).
 * - Within one source, output = input + offset, so reordering, loss and
 *   duplicates keep their relation.
 * - The first packet of a new source continues from the highest output so far:
 *   `sequenceNumber + 1`, `timestamp + step` (see {@link RtpTimestampStepMode}).
 *   16-bit sequence numbers and 32-bit timestamps wrap around.
 * - A new source starts when the `source` key passed to {@link rewrite}
 *   changes, when the input SSRC changes (`switchOnSsrcChange`, default on) or
 *   at the next packet after {@link switchSource}.
 * - Late packets of a replaced source (its `source` key, or its SSRC with
 *   `switchOnSsrcChange`) are dropped (`staleSource`). Without keys and SSRC
 *   changes, old and new packets cannot be told apart after {@link switchSource};
 *   pass a `source` key per upstream connection to drop them.
 * - Packets of a new source that are older (signed 16-bit sequence distance
 *   below 0, tracked across wraps) than its first packet are dropped
 *   (`beforeSourceStart`): their output would be at or before the previous
 *   source's output, which a downstream SRTP receiver rejects as a replay. The
 *   first packet and everything after it is accepted. This does not apply to
 *   the first source, which has nothing before it.
 *
 * So the output sequence number never goes back to or repeats a number of an
 * earlier source, which keeps the downstream SRTP rollover counter estimation
 * and replay window intact.
 *
 * Padding-only packets are in the media sequence space and are rewritten like
 * media (dropping them would leave sequence gaps), but they do not count as a
 * timestamp increment for `"lastDelta"`. RTX packets have their own SSRC and
 * sequence space: do not pass them to the same instance (restore them to the
 * media stream first, as werift's receiver does, or use a separate instance).
 * Use one instance per downstream stream (audio and video separately).
 *
 * Not handled here: a decoder downstream needs a key frame of the new source,
 * so request one upstream (PLI / FIR, for example
 * `RTCRtpReceiver.sendRtcpPLI`) after a switch. Upstream RTCP Sender Reports
 * carry the upstream SSRC / RTP timestamps; rewrite their RTP timestamp with
 * {@link mapTimestamp} and their SSRC, or generate downstream SRs yourself.
 */
export class RtpTimelineRewriter {
  /** A new source started on the output ({@link RtpTimelineSwitch}). */
  readonly onSourceSwitch = new Event<[RtpTimelineSwitch]>();
  /** A packet was dropped. Receives the input packet. */
  readonly onDrop = new Event<[RtpPacket, RtpTimelineDropReason]>();

  private readonly continuity = new RtpContinuity();
  private readonly options: RtpTimelineRewriterOptions;
  private readonly now: () => number;

  private started = false;
  private currentSource: unknown = undefined;
  private currentSsrc?: number;
  private readonly retired = new RetiredSources();

  /** A switch is waiting for the first packet of the new source. */
  private pendingSwitch = false;
  private pendingTimestampStep?: number;

  /** The current source continues an earlier one (start check applies). */
  private guardSourceStart = false;
  private sourceHasPacket = false;
  private sourceHighestSeq = 0;
  /** Highest input sequence number of the source, relative to its first packet. */
  private sourceHighestExtended = 0;

  private highestSequenceNumber?: number;
  private highestTimestamp?: number;
  private lastTimestampDelta?: number;
  /** Arrival time of the packet that set `highestTimestamp`. */
  private lastPacketTime?: number;

  constructor(options: RtpTimelineRewriterOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  /** Last output sequence number; undefined before the first packet. */
  get sequenceNumber() {
    return this.continuity.sequenceNumber;
  }

  /** Last output timestamp; undefined before the first packet. */
  get timestamp() {
    return this.continuity.timestamp;
  }

  /**
   * Output timestamp of an input timestamp of the current source (for example
   * to rewrite the RTP timestamp of an upstream Sender Report). Until the first
   * packet of a new source is rewritten, this still uses the previous source's offset.
   */
  mapTimestamp(inputTimestamp: number) {
    return this.continuity.mapTimestamp(inputTimestamp);
  }

  /**
   * Start a new source at the next packet.
   * @param options.source `source` key of the new source. When given, packets
   * with the current key are dropped from now on; packets must then carry this key.
   * @param options.timestampStep Timestamp increment for this switch only,
   * instead of {@link RtpTimelineRewriterOptions.timestampStep}.
   */
  switchSource(options: { source?: unknown; timestampStep?: number } = {}) {
    if ("source" in options && !Object.is(options.source, this.currentSource)) {
      if (this.started) {
        this.retired.add(this.currentSource);
      }
      this.started = true;
      this.currentSource = options.source;
      // The old source's SSRC must not be taken as an SSRC change of the new key.
      this.currentSsrc = undefined;
    }
    this.pendingSwitch = true;
    this.pendingTimestampStep = options.timestampStep;
  }

  /**
   * Rewrite one packet onto the output timeline.
   * @param options.source Identity of the upstream source (for example a
   * connection generation number). A new key starts a new source.
   * @returns the rewritten packet (a clone unless `inPlace`), or undefined when
   * the packet is dropped ({@link RtpTimelineDropReason}).
   */
  rewrite(
    packet: RtpPacket,
    options: { source?: unknown } = {},
  ): RtpPacket | undefined {
    const source = options.source;
    const ssrc = packet.header.ssrc;
    const switchOnSsrc = this.options.switchOnSsrcChange ?? true;

    if (this.retired.has(source, ssrc, switchOnSsrc)) {
      this.onDrop.execute(packet, RtpTimelineDropReason.staleSource);
      return undefined;
    }

    if (!this.started) {
      this.started = true;
      this.currentSource = source;
    } else if (!Object.is(source, this.currentSource)) {
      this.retired.add(this.currentSource);
      this.currentSource = source;
      this.pendingSwitch = true;
    } else if (
      switchOnSsrc &&
      this.currentSsrc !== undefined &&
      ssrc !== this.currentSsrc
    ) {
      this.retired.add(this.currentSource, this.currentSsrc);
      this.pendingSwitch = true;
    }

    const sequenceNumber = packet.header.sequenceNumber;
    const timestamp = packet.header.timestamp;
    const now = this.now();
    let timestampStep: number | undefined;

    if (this.pendingSwitch) {
      this.pendingSwitch = false;
      this.sourceHasPacket = false;
      this.currentSsrc = undefined;
      if (this.highestSequenceNumber !== undefined) {
        timestampStep = this.timestampStepFor(now);
        this.continuity.schedule(timestampStep, {
          sequenceNumber: this.highestSequenceNumber,
          timestamp: this.highestTimestamp!,
        });
        this.guardSourceStart = true;
      }
      this.pendingTimestampStep = undefined;
    }

    if (!this.sourceHasPacket) {
      this.sourceHasPacket = true;
      this.currentSsrc = ssrc;
      this.sourceHighestSeq = sequenceNumber;
      this.sourceHighestExtended = 0;
    } else {
      const diff = seqDiff(sequenceNumber, this.sourceHighestSeq);
      const extended = this.sourceHighestExtended + diff;
      if (this.guardSourceStart && extended < 0) {
        this.onDrop.execute(packet, RtpTimelineDropReason.beforeSourceStart);
        return undefined;
      }
      if (diff > 0) {
        this.sourceHighestSeq = sequenceNumber;
        this.sourceHighestExtended = extended;
      }
    }

    const out = this.options.inPlace ? packet : packet.clone();
    const rewritten = this.continuity.assign(
      out.header,
      sequenceNumber,
      timestamp,
    );
    if (this.options.ssrc !== undefined) {
      out.header.ssrc = this.options.ssrc;
    }
    if (this.options.payloadType !== undefined) {
      out.header.payloadType = this.options.payloadType;
    }

    this.observeOutput(out, rewritten, now);

    if (rewritten) {
      this.onSourceSwitch.execute({
        source: this.currentSource,
        inputSsrc: ssrc,
        sequenceNumber: out.header.sequenceNumber,
        timestamp: out.header.timestamp,
        timestampStep: timestampStep!,
      });
    }
    return out;
  }

  private observeOutput(out: RtpPacket, rewritten: boolean, now: number) {
    const { sequenceNumber, timestamp } = out.header;
    if (
      this.highestSequenceNumber === undefined ||
      seqDiff(sequenceNumber, this.highestSequenceNumber) > 0
    ) {
      this.highestSequenceNumber = sequenceNumber;
    }
    // The wall-clock reference is the arrival time of the packet that carries
    // the highest timestamp. Padding (same timestamp) and late packets (older
    // timestamp) must not move it, or the elapsed time added at a switch would
    // differ between streams (audio / video) switched at the same moment.
    if (this.highestTimestamp === undefined) {
      this.highestTimestamp = timestamp;
      this.lastPacketTime = now;
    } else {
      const delta = tsDiff(timestamp, this.highestTimestamp);
      if (delta > 0) {
        // The switch increment is synthetic and padding reuses timestamps:
        // neither is an interval of the media itself.
        if (!rewritten && !isPaddingOnlyRtpPacket(out)) {
          this.lastTimestampDelta = delta;
        }
        this.highestTimestamp = timestamp;
        this.lastPacketTime = now;
      }
    }
  }

  private timestampStepFor(now: number): number {
    const fallback = this.options.defaultTimestampStep ?? 1;
    let step: number;
    if (this.pendingTimestampStep !== undefined) {
      step = this.pendingTimestampStep;
    } else {
      const mode = this.options.timestampStep ?? "auto";
      if (typeof mode === "number") {
        step = mode;
      } else if (
        (mode === "wallClock" || mode === "auto") &&
        this.options.clockRate !== undefined &&
        this.lastPacketTime !== undefined
      ) {
        step = Math.round(
          ((now - this.lastPacketTime) * this.options.clockRate) / 1000,
        );
      } else if (mode === "wallClock") {
        step = fallback;
      } else {
        step = this.lastTimestampDelta ?? fallback;
      }
    }
    // Keep the new timestamp ahead of the old one in 32-bit signed distance.
    return Math.min(Math.max(1, Math.trunc(step)), 0x7fffffff);
  }
}
