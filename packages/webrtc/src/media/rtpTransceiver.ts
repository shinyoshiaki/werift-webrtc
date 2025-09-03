import { randomUUID } from "crypto";
import { Event } from "../imports/common";

import type { RTCDtlsTransport } from "..";
import { SenderDirections } from "../const";
import type { Kind } from "../types/domain";
import type {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "./parameters";
import type { RTCRtpReceiver } from "./rtpReceiver";
import type { RTCRtpSender } from "./rtpSender";
import {
  type RTCCodecStats,
  type RTCStats,
  generateStatsId,
  getStatsTimestamp,
} from "./stats";
import type { MediaStream, MediaStreamTrack } from "./track";

export class RTCRtpTransceiver {
  readonly id = randomUUID().toString();
  readonly onTrack = new Event<[MediaStreamTrack, RTCRtpTransceiver]>();
  mid?: string;
  mLineIndex?: number;
  /**should not be reused because it has been used for sending before. */
  usedForSender = false;
  private _currentDirection?: MediaDirection;
  offerDirection!: MediaDirection;
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
    dtlsTransport: RTCDtlsTransport | undefined,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    /**RFC 8829 4.2.4.  direction the transceiver was initialized with */
    private _direction: MediaDirection,
  ) {
    if (dtlsTransport) {
      this.setDtlsTransport(dtlsTransport);
    }
  }

  get dtlsTransport() {
    return this.receiver.dtlsTransport;
  }

  /**RFC 8829 4.2.4. setDirectionに渡された最後の値を示します */
  get direction() {
    return this._direction;
  }

  setDirection(direction: MediaDirection) {
    this._direction = direction;
    if (SenderDirections.includes(this._currentDirection ?? "")) {
      this.usedForSender = true;
    }
  }

  /**RFC 8829 4.2.5. last negotiated direction */
  get currentDirection(): MediaDirection | undefined {
    return this._currentDirection;
  }

  setCurrentDirection(direction: MediaDirection | undefined) {
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
      codec.mimeType.toLowerCase().includes(mimeType.toLowerCase()),
    )?.payloadType;
  }

  getCodecStats(): RTCStats[] {
    const timestamp = getStatsTimestamp();
    const stats: RTCStats[] = [];

    if (!this.dtlsTransport) {
      return stats;
    }

    const transportId = generateStatsId("transport", this.dtlsTransport.id);

    // Add codec stats for each codec
    for (const codec of this.codecs) {
      const codecStats: RTCCodecStats = {
        type: "codec",
        id: generateStatsId("codec", codec.payloadType, transportId),
        timestamp,
        payloadType: codec.payloadType,
        transportId,
        mimeType: codec.mimeType,
        clockRate: codec.clockRate,
        channels: codec.channels,
        sdpFmtpLine: codec.parameters,
      };
      stats.push(codecStats);
    }

    return stats;
  }
}

export const Inactive = "inactive";
export const Sendonly = "sendonly";
export const Recvonly = "recvonly";
export const Sendrecv = "sendrecv";

export const Directions = [Inactive, Sendonly, Recvonly, Sendrecv] as const;

export type MediaDirection = (typeof Directions)[number];

type SimulcastDirection = "send" | "recv";

export interface TransceiverOptions {
  direction: MediaDirection;
  simulcast: { direction: SimulcastDirection; rid: string }[];
  streams: MediaStream[];
}
