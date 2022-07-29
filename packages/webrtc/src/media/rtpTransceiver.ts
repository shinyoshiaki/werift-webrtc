import Event from "rx.mini";
import * as uuid from "uuid";

import { RTCDtlsTransport } from "..";
import { SenderDirections } from "../const";
import { Kind } from "../types/domain";
import {
    RTCRtpCodecParameters,
    RTCRtpHeaderExtensionParameters
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { MediaStreamTrack } from "./track";

export class RTCRtpTransceiver {
  readonly uuid = uuid.v4();
  readonly onTrack = new Event<[MediaStreamTrack]>();
  mid?: string;
  mLineIndex?: number;
  usedForSender = false;
  private _currentDirection?: Direction | "stopped";
  set currentDirection(direction: Direction | "stopped" | undefined) {
    this._currentDirection = direction;
    if (SenderDirections.includes(this._currentDirection || "")) {
      this.usedForSender = true;
    }
  }
  /**RFC 8829 4.2.5. last negotiated direction */
  get currentDirection(): Direction | "stopped" | undefined {
    return this._currentDirection;
  }

  offerDirection!: Direction;
  _codecs: RTCRtpCodecParameters[] = [];
  set codecs(codecs: RTCRtpCodecParameters[]) {
    this._codecs = codecs;
  }
  get codecs() {
    return this._codecs;
  }
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  options: Partial<TransceiverOptions> = {};
  stopping = false;
  stopped = false;

  constructor(
    public readonly kind: Kind,
    dtlsTransport: RTCDtlsTransport,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    /**RFC 8829 4.2.4.  direction the transceiver was initialized with */
    public direction: Direction
  ) {
    this.setDtlsTransport(dtlsTransport);
  }

  get dtlsTransport() {
    return this.receiver.dtlsTransport;
  }

  setDtlsTransport(dtls: RTCDtlsTransport) {
    this.receiver.setDtlsTransport(dtls);
    this.sender.setDtlsTransport(dtls);
  }

  get msid() {
    return `${this.sender.streamId} ${this.sender.trackId}`;
  }

  addTrack(track: MediaStreamTrack) {
    const res = this.receiver.addTrack(track);
    if (res) this.onTrack.execute(track);
  }

  // todo impl
  // https://www.w3.org/TR/webrtc/#methods-8
  stop() {
    if (this.stopping) return;

    // todo Stop sending and receiving with transceiver.

    this.stopping = true;
  }

  getPayloadType(mimeType: string) {
    return this.codecs.find((codec) =>
      codec.mimeType.toLowerCase().includes(mimeType.toLowerCase())
    )?.payloadType;
  }
}

export const Directions = [
  "inactive",
  "sendonly",
  "recvonly",
  "sendrecv",
] as const;

export type Direction = typeof Directions[number];

type SimulcastDirection = "send" | "recv";

export interface TransceiverOptions {
  direction: Direction;
  simulcast: { direction: SimulcastDirection; rid: string }[];
}
