import Event from "rx.mini";
import * as uuid from "uuid";

import { RTCDtlsTransport } from "..";
import { SenderDirections } from "../const";
import { Kind } from "../types/domain";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { MediaStreamTrack } from "./track";

export class RTCRtpTransceiver {
  readonly uuid = uuid.v4();
  readonly onTrack = new Event<[MediaStreamTrack, RTCRtpTransceiver]>();
  mid?: string;
  mLineIndex?: number;
  usedForSender = false;
  private _currentDirection: CurrentDirection = this.direction;
  set currentDirection(direction: CurrentDirection) {
    this._currentDirection = direction;
    if (SenderDirections.includes(this._currentDirection)) {
      this.usedForSender = true;
    }
  }
  /**RFC 8829 4.2.5. last negotiated direction */
  get currentDirection(): CurrentDirection {
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

  constructor(
    public readonly kind: Kind,
    dtlsTransport: RTCDtlsTransport,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    /**RFC 8829 4.2.4.  direction the transceiver was initialized with */
    public readonly direction: Direction
  ) {
    this.setDtlsTransport(dtlsTransport);
    this.currentDirection = direction;
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
    if (res) {
      this.onTrack.execute(track, this);
    }
  }

  // todo impl
  // https://www.w3.org/TR/webrtc/#methods-8
  stop() {}

  getPayloadType(mimeType: string) {
    return this.codecs.find((codec) =>
      codec.mimeType.toLowerCase().includes(mimeType.toLowerCase())
    )?.payloadType;
  }
}

export const Inactive = "inactive";
export const Sendonly = "sendonly";
export const Recvonly = "recvonly";
export const Sendrecv = "sendrecv";

export const Directions = [Inactive, Sendonly, Recvonly, Sendrecv] as const;

export type Direction = typeof Directions[number];
export type CurrentDirection = Direction | "stopped";

type SimulcastDirection = "send" | "recv";

export interface TransceiverOptions {
  direction: Direction;
  simulcast: { direction: SimulcastDirection; rid: string }[];
}
