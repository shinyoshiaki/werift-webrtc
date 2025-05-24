import * as uuid from "uuid";
import { Event } from "../imports/common";

import type { RTCDtlsTransport } from "..";
import { SenderDirections } from "../const";
import type { Kind } from "../types/domain";
import {
  RTCRtpCodecParameters,
  RTCRtpEncodingParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpSendParameters,
} from "./parameters";
import type { RTCRtpReceiver } from "./rtpReceiver";
import type { RTCRtpSender } from "./rtpSender";
import type { MediaStream, MediaStreamTrack } from "./track";

export class RTCRtpTransceiver {
  readonly id = uuid.v4();
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
  private sendEncodings: RTCRtpEncodingParameters[] = [];
  stopping = false;
  stopped = false;

  constructor(
    public readonly kind: Kind,
    dtlsTransport: RTCDtlsTransport | undefined,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    /**RFC 8829 4.2.4.  direction the transceiver was initialized with */
    private _direction: MediaDirection,
    public options: Partial<TransceiverOptions> = {}, // Added options here
  ) {
    if (dtlsTransport) {
      this.setDtlsTransport(dtlsTransport);
    }
    if (options.simulcast) {
      this.sendEncodings = options.simulcast
        .filter(
          (s): s is SimulcastParametersSend => s.direction === "send",
        )
        .map((s) => {
          const { direction, ...encodingParams } = s;
          return new RTCRtpEncodingParameters(encodingParams);
        });
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

    if (
      this._currentDirection &&
      SenderDirections.includes(this._currentDirection) &&
      this.sendEncodings.length > 0
    ) {
      if (this.codecs.length === 0) {
        console.warn(
          "RTCRtpTransceiver.setCurrentDirection: Cannot set sender parameters without codecs. Codecs are typically set via SDP negotiation.",
        );
        return;
      }
      const params: RTCRtpSendParameters = {
        codecs: this.codecs,
        headerExtensions: this.headerExtensions,
        encodings: this.sendEncodings,
        muxId: this.mid,
        // rtcp parameters could be added if available and needed by sender.setParameters
      };
      this.sender.setParameters(params).catch((err) => {
        console.error("Error setting sender parameters:", err);
      });
    }
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
}

export const Inactive = "inactive";
export const Sendonly = "sendonly";
export const Recvonly = "recvonly";
export const Sendrecv = "sendrecv";

export const Directions = [Inactive, Sendonly, Recvonly, Sendrecv] as const;

export type MediaDirection = (typeof Directions)[number];

// Define SimulcastParameters types for TransceiverOptions
export interface SimulcastParametersBase {
  rid: string;
}

export interface SimulcastParametersRecv extends SimulcastParametersBase {
  direction: "recv";
}

export interface SimulcastParametersSend
  extends RTCRtpEncodingParameters, // Inherits all optional fields from RTCRtpEncodingParameters
    SimulcastParametersBase {
  direction: "send";
  // rid is mandatory for send, inherited from SimulcastParametersBase
  // Other RTCRtpEncodingParameters like scalabilityMode, scaleResolutionDownBy, maxBitrate etc. are optional
}

export type SimulcastParameters =
  | SimulcastParametersRecv
  | SimulcastParametersSend;

export interface TransceiverOptions {
  direction: MediaDirection;
  simulcast?: SimulcastParameters[];
  streams: MediaStream[];
}
