import { uint16Add, uint16Gt, uint32Add, uint32Gt } from "../imports/common";
import type { RtpHeader, RtpPacket } from "./rtp";

/**
 * Serializable state of {@link RtpContinuityRewriter}.
 * Pass it to `new RtpContinuityRewriter({ state })` to carry one output
 * timeline over to another instance.
 */
export interface RtpContinuityState {
  /** Most advanced output sequence number (16-bit wrap aware). `undefined` until the first output. */
  highestOutputSequenceNumber?: number;
  /** Most advanced output timestamp (32-bit wrap aware), tracked independently of the sequence number. */
  highestOutputTimestamp?: number;
  /** uint16 offset added to input sequence numbers of the current generation. */
  seqOffset: number;
  /** uint32 offset added to input timestamps of the current generation. */
  timestampOffset: number;
  /** Set by `switchSource()` until the next rewritten packet freezes the offsets. */
  pending?: { timestampStep: number };
  /** Incremented by every `switchSource()` / `reset()`. For generation checks and debugging. */
  generation: number;
}

export interface RtpContinuityRewriterOptions {
  /** Output SSRC. Rewritten only when set; otherwise the input SSRC is kept. */
  ssrc?: number;
  /** Restore a previous state to keep the output timeline continuous. */
  state?: RtpContinuityState;
}

/**
 * Keeps one continuous output RTP timeline (sequence number / timestamp)
 * while the input RTP source is replaced (source replacement, relays,
 * reconnecting upstreams).
 *
 * - The first source passes through unchanged (offsets 0).
 * - `switchSource()` only marks the switch as pending. The first packet
 *   rewritten afterwards freezes the offsets so that it becomes
 *   `highestOutputSequenceNumber + 1` / `highestOutputTimestamp + timestampStep`.
 *   Every later packet of the same generation uses the same fixed offsets;
 *   offsets are never re-derived from per-packet deltas, so loss, duplicates,
 *   reordering and frames sharing one timestamp are kept as-is.
 * - The reference point is the most advanced output (16/32-bit wrap aware),
 *   not the last output, so a reordered old packet right before a switch
 *   cannot make the new source collide with already-sent sequence numbers.
 *
 * Responsibilities left to the caller:
 * - SSRC: rewritten only when the `ssrc` option is set.
 * - Payload type: not touched. Rewrite it yourself when upstream and downstream differ.
 * - RTX: not handled. Translate an upstream OSN with `translateSequenceNumber()`,
 *   drop retransmission history on switch, and keep the RTX sequence space separate.
 * - Downstream NACK: no reverse mapping. Retransmit from your own history keyed
 *   by output sequence number.
 * - RTCP SR: not handled. Generate SR from the rewritten timestamp, or convert a
 *   forwarded SR's rtpTimestamp with `translateTimestamp()` and fix its SSRC.
 * - TWCC: not handled. Number transport-wide sequence numbers per transport and
 *   strip or replace upstream TWCC extensions.
 * - The state is live output state, not negotiation state: do not roll it back
 *   together with a session description, or already-sent sequence numbers are reused.
 */
export class RtpContinuityRewriter {
  private ssrc?: number;
  private highestOutputSequenceNumber?: number;
  private highestOutputTimestamp?: number;
  private seqOffset = 0;
  private timestampOffset = 0;
  private pendingTimestampStep?: number;
  private generation = 0;

  constructor(options: RtpContinuityRewriterOptions = {}) {
    this.ssrc = options.ssrc;
    const { state } = options;
    if (state) {
      this.highestOutputSequenceNumber =
        state.highestOutputSequenceNumber == undefined
          ? undefined
          : uint16Add(state.highestOutputSequenceNumber, 0);
      this.highestOutputTimestamp =
        state.highestOutputTimestamp == undefined
          ? undefined
          : uint32Add(state.highestOutputTimestamp, 0);
      this.seqOffset = uint16Add(state.seqOffset, 0);
      this.timestampOffset = uint32Add(state.timestampOffset, 0);
      this.pendingTimestampStep = state.pending?.timestampStep;
      this.generation = state.generation;
    }
  }

  /**
   * Mark a source switch. The next rewritten packet freezes the offsets.
   * Calling it again before that packet overrides `timestampStep` (last wins).
   * @param options.timestampStep timestamp increment at the boundary. Default 1.
   *   See {@link timestampStepFromElapsed} to reflect wall-clock gaps.
   */
  switchSource({ timestampStep = 1 }: { timestampStep?: number } = {}) {
    this.pendingTimestampStep = timestampStep;
    this.generation++;
  }

  /** Drop a pending switch that has not been frozen yet. */
  cancelPendingSwitch() {
    this.pendingTimestampStep = undefined;
  }

  /**
   * Rewrite a packet without mutating the input.
   * Returns `packet.clone()`, which is a shallow copy: the payload Buffer and
   * the header's `extensions` / `csrc` arrays are shared with the input.
   * Only primitive header fields (sequence number, timestamp, SSRC) are rewritten.
   */
  rewrite(packet: RtpPacket): RtpPacket {
    const output = packet.clone();
    this.rewriteHeaderInPlace(output.header);
    return output;
  }

  /**
   * Rewrite `header` in place (sequence number, timestamp and, when the `ssrc`
   * option is set, SSRC). For callers that already own a cloned header.
   */
  rewriteHeaderInPlace(header: RtpHeader) {
    if (this.pendingTimestampStep != undefined) {
      if (
        this.highestOutputSequenceNumber != undefined &&
        this.highestOutputTimestamp != undefined
      ) {
        this.seqOffset = uint16Add(
          uint16Add(this.highestOutputSequenceNumber, 1),
          -header.sequenceNumber,
        );
        this.timestampOffset = uint32Add(
          uint32Add(this.highestOutputTimestamp, this.pendingTimestampStep),
          -header.timestamp,
        );
      }
      this.pendingTimestampStep = undefined;
    }

    header.sequenceNumber = this.translateSequenceNumber(header.sequenceNumber);
    header.timestamp = this.translateTimestamp(header.timestamp);
    if (this.ssrc != undefined) {
      header.ssrc = this.ssrc;
    }

    if (
      this.highestOutputSequenceNumber == undefined ||
      uint16Gt(header.sequenceNumber, this.highestOutputSequenceNumber)
    ) {
      this.highestOutputSequenceNumber = header.sequenceNumber;
    }
    if (
      this.highestOutputTimestamp == undefined ||
      uint32Gt(header.timestamp, this.highestOutputTimestamp)
    ) {
      this.highestOutputTimestamp = header.timestamp;
    }
  }

  /** Map an input sequence number of the current (frozen) generation to its output value. */
  translateSequenceNumber(inputSeq: number) {
    return uint16Add(inputSeq, this.seqOffset);
  }

  /** Map an input timestamp of the current (frozen) generation to its output value. */
  translateTimestamp(inputTimestamp: number) {
    return uint32Add(inputTimestamp, this.timestampOffset);
  }

  /** Discard the output timeline and start a new generation; the next input passes through unchanged. */
  reset() {
    this.highestOutputSequenceNumber = undefined;
    this.highestOutputTimestamp = undefined;
    this.seqOffset = 0;
    this.timestampOffset = 0;
    this.pendingTimestampStep = undefined;
    this.generation++;
  }

  /** A copy of the current state. */
  get state(): RtpContinuityState {
    return {
      highestOutputSequenceNumber: this.highestOutputSequenceNumber,
      highestOutputTimestamp: this.highestOutputTimestamp,
      seqOffset: this.seqOffset,
      timestampOffset: this.timestampOffset,
      pending:
        this.pendingTimestampStep == undefined
          ? undefined
          : { timestampStep: this.pendingTimestampStep },
      generation: this.generation,
    };
  }

  toJSON(): Record<string, unknown> {
    return { ...this.state, ssrc: this.ssrc };
  }
}

/**
 * Timestamp step for `switchSource()` that reflects a wall-clock gap at the
 * boundary. Returns at least 1 so the new source never reuses the last timestamp.
 * @param elapsedMs elapsed time since the last output packet
 * @param clockRate RTP clock rate (e.g. 90000 for video)
 */
export function timestampStepFromElapsed(elapsedMs: number, clockRate: number) {
  if (!Number.isFinite(clockRate) || clockRate <= 0) {
    throw new RangeError(`invalid clockRate ${clockRate}`);
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 1;
  }
  return Math.max(
    1,
    Math.min(0x7fffffff, Math.round((elapsedMs * clockRate) / 1000)),
  );
}
