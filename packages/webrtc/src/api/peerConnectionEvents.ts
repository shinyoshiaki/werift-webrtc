import type { RTCDataChannel } from "../dataChannel";
import type {
  MediaStream,
  MediaStreamTrack,
  RTCRtpReceiver,
  RTCRtpTransceiver,
} from "../media";
import type { RTCIceCandidate } from "../transport/ice";
import type { Callback, CallbackWithValue } from "../types/util";

// Events RTCPeerConnection dispatches and the `on*` handler attributes.

export class RTCTrackEvent {
  readonly type = "track";
  readonly track: MediaStreamTrack;
  readonly streams: MediaStream[];
  readonly transceiver: RTCRtpTransceiver;
  readonly receiver: RTCRtpReceiver;

  constructor(init: {
    track: MediaStreamTrack;
    streams: MediaStream[];
    transceiver: RTCRtpTransceiver;
    receiver: RTCRtpReceiver;
  }) {
    this.track = init.track;
    this.streams = [...init.streams];
    this.transceiver = init.transceiver;
    this.receiver = init.receiver;
  }
}

/** Members of {@link RTCPeerConnectionIceErrorEvent} (W3C RTCPeerConnectionIceErrorEventInit). */
export interface RTCPeerConnectionIceErrorEventInit {
  address?: string | null;
  port?: number | null;
  url?: string;
  errorCode: number;
  errorText?: string;
  /** Standard `EventInit` members. */
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

/**
 * `icecandidateerror` (W3C WebRTC §4.8.2): a configured STUN or TURN server
 * could not give a candidate while gathering. `RTCPeerConnection` fires one
 * per failing server URL, local socket and gathering generation, never after
 * `close()`.
 *
 * - `url`: the configured URL of the server, canonical: trimmed, lower-case
 *   scheme, and `?transport=tcp` added to a `turns:` URL that names no
 *   transport (`turns:h:5349` → `turns:h:5349?transport=tcp`, the Chrome /
 *   WPT form). Several URLs naming one server each get their own event. The
 *   built-in default STUN server (`iceUseDefaultStunServer`) has no URL in
 *   the configuration and is not reported.
 * - `errorCode`: the STUN error code the server answered with (300-699),
 *   or 701 when it was not reached (DNS, timeout, connect or socket error).
 * - `errorText`: the server's reason phrase or a fixed description; it never
 *   contains a credential.
 * - `address` / `port`: the local host address used to contact a STUN
 *   server; `null` / `0` when unknown (TURN) or hidden (the `"relay"` ICE
 *   transport policy).
 */
export class RTCPeerConnectionIceErrorEvent extends Event {
  readonly address: string | null;
  readonly port: number | null;
  readonly url: string;
  readonly errorCode: number;
  readonly errorText: string;

  constructor(type: string, init: RTCPeerConnectionIceErrorEventInit) {
    super(type, {
      bubbles: init?.bubbles,
      cancelable: init?.cancelable,
      composed: init?.composed,
    });
    if (init == null || typeof init.errorCode !== "number") {
      throw new TypeError(
        "RTCPeerConnectionIceErrorEvent: errorCode is required",
      );
    }
    this.address = init.address ?? null;
    this.port = init.port ?? null;
    this.url = init.url ?? "";
    this.errorCode = init.errorCode;
    this.errorText = init.errorText ?? "";
  }
}

export interface RTCDataChannelEvent {
  type?: "datachannel";
  channel: RTCDataChannel;
}

export interface RTCPeerConnectionIceEvent {
  type?: "icecandidate";
  candidate?: RTCIceCandidate;
}

export type PeerConnectionEventHandlers = {
  ondatachannel?: CallbackWithValue<RTCDataChannelEvent>;
  onicecandidate?: CallbackWithValue<RTCPeerConnectionIceEvent>;
  onicecandidateerror?: CallbackWithValue<RTCPeerConnectionIceErrorEvent>;
  onicegatheringstatechange?: CallbackWithValue<any>;
  onnegotiationneeded?: CallbackWithValue<any>;
  onsignalingstatechange?: CallbackWithValue<any>;
  ontrack?: CallbackWithValue<RTCTrackEvent>;
  onconnectionstatechange?: Callback;
  oniceconnectionstatechange?: Callback;
};
