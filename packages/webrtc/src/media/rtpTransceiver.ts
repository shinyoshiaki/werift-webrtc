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
  readonly id = uuid.v4();
  readonly onTrack = new Event<[MediaStreamTrack, RTCRtpTransceiver]>();
  mid?: string;
  mLineIndex?: number;
  /**should not be reused because it has been used for sending before. */
  usedForSender = false;
  private _currentDirection?: Direction;
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
    private _direction: Direction
  ) {
    this.setDtlsTransport(dtlsTransport);
  }

  get dtlsTransport() {
    return this.receiver.dtlsTransport;
  }

  /**RFC 8829 4.2.4. setDirectionに渡された最後の値を示します */
  get direction() {
    return this._direction;
  }

  setDirection(direction: Direction) {
    this._direction = direction;
    if (SenderDirections.includes(this._currentDirection ?? "")) {
      this.usedForSender = true;
    }
  }

  /**RFC 8829 4.2.5. last negotiated direction */
  get currentDirection(): Direction | undefined {
    return this._currentDirection;
  }

  setCurrentDirection(direction: Direction | undefined) {
    this._currentDirection = direction;
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
  stop() {
    if (this.stopping) {
      return;
    }

    // todo Stop sending and receiving with transceiver.

    this.stopping = true;
  }

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

type SimulcastDirection = "send" | "recv";

export interface TransceiverOptions {
  direction: Direction;
  simulcast: { direction: SimulcastDirection; rid: string }[];
}
