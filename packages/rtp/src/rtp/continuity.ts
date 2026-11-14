import { uint16Add, uint32Add } from "../../../common/src";
import type { RtpHeader } from "./rtp";

/**
 * Output sequence number / timestamp of one sender's media stream.
 *
 * Output = input + offset. The offsets change only at a scheduled source
 * switch (`replaceTrack`, `onSourceChanged`): the first packet actually sent
 * after it continues from the last output (`seq + 1`, `timestamp + step`).
 * RTX and padding use their own numbering and never go through this.
 *
 * This is the low-level piece used by `RTCRtpSender`: the caller detects the
 * source switch, chooses the timestamp step and drops late packets of the old
 * source itself. Applications that forward RTP (SFU / relay, RTP-to-SRTP
 * gateways, replay) should use {@link RtpTimelineRewriter}, which does all of
 * that on top of this class.
 */
export class RtpContinuity {
  private _sequenceNumber?: number;
  private _timestamp?: number;
  private timestampOffset = 0;
  private seqOffset = 0;
  private pending = false;
  private pendingTimestampStep = 1;
  private pendingFrom?: { sequenceNumber: number; timestamp: number };

  /** Last sent output sequence number; undefined before the first packet. */
  get sequenceNumber() {
    return this._sequenceNumber;
  }

  /** Last sent output timestamp; undefined before the first packet. */
  get timestamp() {
    return this._timestamp;
  }

  /**
   * Rewrite offsets on the next sent packet.
   * @param timestampStep Timestamp increment across the source boundary.
   * @param from Output to continue from instead of the last assigned one
   * (for example the highest output when the last assigned packet was a
   * reordered older one). Omitted: the last assigned output.
   */
  schedule(
    timestampStep = 1,
    from?: { sequenceNumber: number; timestamp: number },
  ) {
    this.pending = true;
    this.pendingTimestampStep = timestampStep;
    this.pendingFrom = from;
  }

  /** Forget a scheduled rewrite (track detached / sender stopped). */
  cancel() {
    this.pending = false;
    this.pendingFrom = undefined;
  }

  /** Output timestamp of `inputTimestamp` with the current offset (before send). */
  mapTimestamp(inputTimestamp: number) {
    return uint32Add(inputTimestamp, this.timestampOffset);
  }

  /**
   * Assign the output sequence number / timestamp of a media packet that is
   * about to be written, applying a scheduled rewrite first.
   * @returns true when a rewrite moved the offsets (a new RTP clock origin).
   */
  assign(
    header: RtpHeader,
    inputSequenceNumber: number,
    inputTimestamp: number,
  ): boolean {
    let rewritten = false;
    if (this.pending) {
      const lastSequenceNumber =
        this.pendingFrom?.sequenceNumber ?? this._sequenceNumber;
      const lastTimestamp = this.pendingFrom?.timestamp ?? this._timestamp;
      if (lastSequenceNumber != undefined && lastTimestamp != undefined) {
        this.seqOffset = uint16Add(
          uint16Add(lastSequenceNumber, 1),
          -inputSequenceNumber,
        );
        this.timestampOffset = uint32Add(
          uint32Add(lastTimestamp, this.pendingTimestampStep),
          -inputTimestamp,
        );
        rewritten = true;
      }
      this.pending = false;
      this.pendingTimestampStep = 1;
      this.pendingFrom = undefined;
    }

    header.timestamp = uint32Add(inputTimestamp, this.timestampOffset);
    header.sequenceNumber = uint16Add(inputSequenceNumber, this.seqOffset);
    this._timestamp = header.timestamp;
    this._sequenceNumber = header.sequenceNumber;
    return rewritten;
  }
}
