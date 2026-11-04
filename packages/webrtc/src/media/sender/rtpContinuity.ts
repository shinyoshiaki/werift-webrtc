import { uint16Add, uint32Add } from "../../imports/common";
import type { RtpHeader } from "../../imports/rtp";

/**
 * Output sequence number / timestamp of one sender's media stream.
 *
 * Output = input + offset. The offsets change only at a scheduled source
 * switch (`replaceTrack`, `onSourceChanged`): the first packet actually sent
 * after it continues from the last output (`seq + 1`, `timestamp + step`).
 * RTX and padding use their own numbering and never go through this.
 */
export class RtpContinuity {
  private _sequenceNumber?: number;
  private _timestamp?: number;
  private timestampOffset = 0;
  private seqOffset = 0;
  private pending = false;
  private pendingTimestampStep = 1;

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
   */
  schedule(timestampStep = 1) {
    this.pending = true;
    this.pendingTimestampStep = timestampStep;
  }

  /** Forget a scheduled rewrite (track detached / sender stopped). */
  cancel() {
    this.pending = false;
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
      if (this._sequenceNumber != undefined && this._timestamp != undefined) {
        this.seqOffset = uint16Add(
          uint16Add(this._sequenceNumber, 1),
          -inputSequenceNumber,
        );
        this.timestampOffset = uint32Add(
          uint32Add(this._timestamp, this.pendingTimestampStep),
          -inputTimestamp,
        );
        rewritten = true;
      }
      this.pending = false;
      this.pendingTimestampStep = 1;
    }

    header.timestamp = uint32Add(inputTimestamp, this.timestampOffset);
    header.sequenceNumber = uint16Add(inputSequenceNumber, this.seqOffset);
    this._timestamp = header.timestamp;
    this._sequenceNumber = header.sequenceNumber;
    return rewritten;
  }
}
