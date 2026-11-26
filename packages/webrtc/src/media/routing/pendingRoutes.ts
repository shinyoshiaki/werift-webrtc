import type { RTCRtpReceiver } from "../rtpReceiver";

/**
 * SSRC routes a pending description staged or added provisionally, one per
 * SSRC and RTP session: a later entry for the same SSRC replaces one of the
 * same transport (the later description decides) and leaves those of other
 * transports, which are other streams.
 */
export class PendingSsrcRoutes {
  private list: [number, RTCRtpReceiver][];

  constructor(entries: [number, RTCRtpReceiver][] = []) {
    this.list = entries.map(([ssrc, receiver]) => [ssrc, receiver]);
  }

  private static sameSession(a: RTCRtpReceiver, b: RTCRtpReceiver) {
    return a === b || a.dtlsTransport === b.dtlsTransport;
  }

  set(ssrc: number, receiver: RTCRtpReceiver) {
    this.delete(ssrc, receiver);
    this.list.push([ssrc, receiver]);
  }

  /** Drop the entry of `ssrc` in `receiver`'s RTP session. */
  delete(ssrc: number, receiver: RTCRtpReceiver) {
    this.list = this.list.filter(
      ([s, r]) => s !== ssrc || !PendingSsrcRoutes.sameSession(r, receiver),
    );
  }

  deleteReceiver(receiver: RTCRtpReceiver) {
    this.list = this.list.filter(([, r]) => r !== receiver);
  }

  clear() {
    this.list = [];
  }

  get size() {
    return this.list.length;
  }

  entries(): [number, RTCRtpReceiver][] {
    return this.list.map(([ssrc, receiver]) => [ssrc, receiver]);
  }

  [Symbol.iterator]() {
    return this.entries()[Symbol.iterator]();
  }
}

/** Staged and provisional routes of a pending description (a snapshot). */
export type StagedRoutes = {
  ssrc: [number, RTCRtpReceiver][];
  rid: [string, RTCRtpReceiver][];
  provisional?: [number, RTCRtpReceiver][];
};
