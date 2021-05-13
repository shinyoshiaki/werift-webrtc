import debug from "debug";
import Event from "rx.mini";
import * as uuid from "uuid";
import { SenderDirections } from "../const";
import { RTCDtlsTransport } from "../transport/dtls";
import { Kind } from "../types/domain";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { MediaStreamTrack } from "./track";

const log = debug("werift:webrtc:rtpTransceiver");

export class RTCRtpTransceiver {
  readonly uuid = uuid.v4();
  readonly onTrack = new Event<[MediaStreamTrack]>();
  mid?: string;
  mLineIndex?: number;
  usedForSender = false;
  private _currentDirection?: Direction | "stopped";
  set currentDirection(direction: Direction) {
    this._currentDirection = direction;
    if (SenderDirections.includes(this._currentDirection)) {
      this.usedForSender = true;
    }
  }
  /**RFC 8829 4.2.5. last negotiated direction */
  get currentDirection() {
    // todo fix typescript 4.3
    return this._currentDirection as any;
  }
  offerDirection!: Direction;
  private _codecs: RTCRtpCodecParameters[] = [];
  get codecs() {
    return this._codecs;
  }
  set codecs(codecs: RTCRtpCodecParameters[]) {
    this._codecs = codecs;
    this.receiver.codecs = codecs;
    this.sender.codec = codecs[0];
  }
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  options: Partial<TransceiverOptions> = {};
  stopping = false;
  stopped = false;

  constructor(
    public readonly kind: Kind,
    public readonly receiver: RTCRtpReceiver,
    public readonly sender: RTCRtpSender,
    /**RFC 8829 4.2.4.  direction the transceiver was initialized with */
    public direction: Direction,
    public dtlsTransport: RTCDtlsTransport
  ) {}

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
