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
 * could not give a candidate while gathering. Never fired after `close()`.
 *
 * - A server that answered with an error response (300-699): fired at once,
 *   once per local socket that asked it.
 * - 701 (server not reached, W3C: no host candidate could reach it): judged
 *   once per gathering, when `iceGatheringState` leaves "gathering" (just
 *   before that `icegatheringstatechange`), and fired once per URL that some
 *   ICE transport of the gathering tried without reaching the server while
 *   none reached it. Only transports still in use at that point count, with
 *   the ICE generation they gathered in: one closed or discarded (rollback)
 *   meanwhile, one that did not try the URL, and a generation an ICE restart
 *   replaced do not count. The event carries the local address of the first
 *   socket that failed (STUN). A new gathering (ICE restart, a new transport)
 *   reports the URL again. A handler that closes the connection stops the
 *   rest: no further 701 nor `icegatheringstatechange` is fired.
 *
 * While listeners run, `target` and `currentTarget` are the
 * `RTCPeerConnection` and `eventPhase` is 2 (`AT_TARGET`); afterwards
 * `currentTarget` is `null` and `eventPhase` 0.
 *
 * - `url`: the configured URL of the server, canonical: trimmed, lower-case
 *   scheme, and `?transport=tcp` added to a `turns:` URL that names no
 *   transport (`turns:h:5349` → `turns:h:5349?transport=tcp`, the Chrome /
 *   WPT form). Several URLs naming one server each get their own event. The
 *   built-in default STUN server (`iceUseDefaultStunServer`, used when no
 *   STUN server is configured) is in no configuration; werift reports it
 *   with the synthesized URL `stun:stun.l.google.com:19302`.
 * - `errorCode`: the STUN error code the server answered with (300-699),
 *   or 701 when it was not reached (DNS, timeout, connect or socket error).
 * - `errorText`: fixed text werift chooses, never the server's reason
 *   phrase: the registered reason phrase of the error code (`"Unauthorized"`
 *   for 401, `"STUN error 499"` for an unregistered one) or a description of
 *   the 701 cause. So it never contains a username, password, realm, nonce
 *   or other text a server sent.
 * - `address` / `port`: the local host address used to contact a STUN
 *   server; `null` / `0` when unknown (TURN) or hidden (the `"relay"` ICE
 *   transport policy), as Chrome and the WPT tests (`port == 0` when
 *   `address` is `null`).
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
