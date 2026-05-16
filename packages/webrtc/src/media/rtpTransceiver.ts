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
  generateCodecStatsId,
  generateStatsId,
  getStatsTimestamp,
} from "./stats";
import type { MediaStream, MediaStreamTrack } from "./track";

export class RTCRtpTransceiver {
  readonly id = randomUUID().toString();
  readonly onTrack = new Event<[MediaStreamTrack, RTCRtpTransceiver]>();
  mid: string | null = null;
  mLineIndex?: number;
  /**should not be reused because it has been used for sending before. */
  usedForSender = false;
  private _currentDirection?: CurrentDirection;
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

  set direction(direction: MediaDirection) {
    this.setDirection(direction);
  }

  setDirection(direction: MediaDirection) {
    this._direction = direction;
    if (
      this._currentDirection &&
      this._currentDirection !== "stopped" &&
      SenderDirections.includes(this._currentDirection)
    ) {
      this.usedForSender = true;
    }
  }

  /**RFC 8829 4.2.5. last negotiated direction */
  get currentDirection(): CurrentDirection | null {
    return this._currentDirection ?? null;
  }

  setCurrentDirection(direction: CurrentDirection | undefined) {
    this._currentDirection = direction;
  }

  setDtlsTransport(dtls: RTCDtlsTransport) {
    this.receiver.setDtlsTransport(dtls);
    this.sender.setDtlsTransport(dtls);
  }

  get msid() {
    return this.msids[0];
  }

  get msids() {
    return this.sender.streamIds.map(
      (streamId) => `${streamId} ${this.sender.trackId}`,
    );
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

  forceStop() {
    if (this.stopped) {
      return;
    }

    this.stopping = true;
    this.stopped = true;
    this.setCurrentDirection("stopped");
    this.receiver.stop();
    this.sender.stop();
  }

  getPayloadType(mimeType: string) {
    return this.codecs.find((codec) =>
      codec.mimeType.toLowerCase().includes(mimeType.toLowerCase()),
    )?.payloadType;
  }

  getCodecStats(): RTCStats[] {
    const timestamp = getStatsTimestamp();
    return this.collectCodecStats(timestamp);
  }

  collectCodecStats(timestamp: number): RTCStats[] {
    const stats: RTCStats[] = [];

    if (!this.dtlsTransport) {
      return stats;
    }

    const transportId = generateStatsId("transport", this.dtlsTransport.id);

    // Add codec stats for each codec
    for (const codec of this.codecs) {
      const codecStats: RTCCodecStats = {
        type: "codec",
        id: generateCodecStatsId(transportId, codec.payloadType, this.id),
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
export type CurrentDirection = MediaDirection | "stopped";

type SimulcastDirection = "send" | "recv";

export interface RTCRtpEncodingParameters {
  active?: boolean;
}

export interface TransceiverOptions {
  direction: MediaDirection;
  sendEncodings: RTCRtpEncodingParameters[];
  simulcast: { direction: SimulcastDirection; rid: string }[];
  streams: MediaStream[];
}
