import { randomUUID } from "crypto";
import { createWebRtcTypeError } from "./errors";
import { EventTarget, notifySafely } from "./helper";
import { debug, Event } from "./imports/common";
import type { RTCSctpTransport } from "./transport/sctp";
import type { Callback, CallbackWithValue } from "./types/util";

/**
 * Label / Protocol Length are 16-bit byte counts of the UTF-8 fields
 * (RFC 8832 5.1); W3C createDataChannel rejects longer values for both
 * negotiated and in-band channels. Call before any state is touched.
 */
export function assertDataChannelFieldLengths(fields: {
  label: string;
  protocol?: string;
}) {
  for (const name of ["label", "protocol"] as const) {
    const bytes = Buffer.byteLength(fields[name] ?? "", "utf8");
    if (bytes > 0xffff) {
      throw createWebRtcTypeError(
        `Data channel ${name} is ${bytes} bytes in UTF-8; the maximum is 65535`,
      );
    }
  }
}

const log = debug("werift:packages/webrtc/src/dataChannel.ts");

export interface DataChannelStats {
  messagesSent: number;
  bytesSent: number;
  messagesReceived: number;
  bytesReceived: number;
}

export function getDataChannelMessageSize(data: Buffer | string) {
  return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
}

export class RTCDataChannel extends EventTarget implements DataChannelStats {
  readonly sctp: RTCSctpTransport;
  private readonly parameters: RTCDataChannelParameters;
  public readonly sendOpen: boolean;

  readonly statsId = randomUUID().toString();
  readonly stateChange = new Event<[DCState]>();
  readonly stateChanged = new Event<[DCState]>();
  readonly onMessage = new Event<[string | Buffer]>();
  // todo impl
  readonly error = new Event<[Error]>();
  /**
   * Fires each time {@link RTCDataChannel.bufferedAmount} falls from above
   * {@link RTCDataChannel.bufferedAmountLowThreshold} to at or below it,
   * together with {@link RTCDataChannel.onbufferedamountlow} and the
   * `bufferedamountlow` event. Never fires once the channel is `closed`.
   */
  readonly bufferedAmountLow = new Event();
  onopen?: Callback;
  onclose?: Callback;
  onclosing?: Callback;
  /** W3C `onbufferedamountlow`; see {@link RTCDataChannel.bufferedAmountLow}. */
  onbufferedamountlow?: Callback;
  onmessage?: CallbackWithValue<MessageEvent>;
  // todo impl
  onerror?: CallbackWithValue<RTCErrorEvent>;
  isCreatedByRemote = false;
  id: number;
  readyState: DCState = "connecting";

  private _bufferedAmount = 0;
  private _bufferedAmountLowThreshold = 0;

  // Statistics
  messagesSent = 0;
  bytesSent = 0;
  messagesReceived = 0;
  bytesReceived = 0;

  constructor(
    sctp: RTCSctpTransport,
    parameters: RTCDataChannelParameters,
    sendOpen = true,
  ) {
    super();
    this.sctp = sctp;
    this.parameters = parameters;
    this.sendOpen = sendOpen;

    assertDataChannelFieldLengths(this.parameters);

    this.id = this.parameters.id;

    if (parameters.negotiated) {
      if (this.id == undefined || this.id < 0 || this.id > 65534) {
        throw new Error(
          "ID must be in range 0-65534 if data channel is negotiated out-of-band",
        );
      }
      this.sctp.dataChannelAddNegotiated(this);
    } else {
      if (sendOpen) {
        this.sendOpen = false;
        this.sctp.dataChannelOpen(this);
      }
    }
  }

  get ordered() {
    return this.parameters.ordered;
  }

  get maxRetransmits() {
    return this.parameters.maxRetransmits ?? null;
  }

  get maxPacketLifeTime() {
    return this.parameters.maxPacketLifeTime ?? null;
  }

  get label() {
    return this.parameters.label;
  }

  get protocol() {
    return this.parameters.protocol;
  }

  get negotiated() {
    return this.parameters.negotiated;
  }

  /**
   * Bytes of application data (UTF-8 for strings) queued by
   * {@link RTCDataChannel.send} and not yet handed to the network
   * (W3C webrtc-pc `bufferedAmount`, read-only).
   *
   * - Grows synchronously in `send()` by the message size; an empty message
   *   adds nothing.
   * - Shrinks once SCTP hands a message's last chunk to the network (not when
   *   the peer acknowledges it, so it reaches 0 before retransmissions end),
   *   and for a partially reliable channel also when SCTP abandons it.
   * - Messages still queued while `closing` keep counting and shrink as they
   *   are sent. What is thrown away unsent (`RTCPeerConnection.close()`, the
   *   transport stopping, the association ending) is never subtracted, so the
   *   value does not reset to zero once the channel closes.
   *
   * Use it with {@link RTCDataChannel.bufferedAmountLowThreshold} and
   * `bufferedamountlow` for backpressure.
   * @see tests/datachannel/bufferedAmount.test.ts
   */
  get bufferedAmount() {
    return this._bufferedAmount;
  }

  /**
   * `bufferedamountlow` fires when {@link RTCDataChannel.bufferedAmount} falls
   * from above this value to at or below it. 0..2^32-1, default 0.
   */
  get bufferedAmountLowThreshold() {
    return this._bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    if (value < 0 || value > 4294967295) {
      throw new Error(
        "bufferedAmountLowThreshold must be in range 0 - 4294967295",
      );
    }
    this._bufferedAmountLowThreshold = value;
  }

  /**
   * Internal: `undefined` gives a reserved stream ID back.
   * @see tests/issue/815.test.ts "a rollback gives back the IDs a pranswer reserved"
   */
  setId(id: number | undefined) {
    this.id = id as number;
  }

  /**
   * Internal: W3C webrtc-pc 4.4.1.6 step 2.2.6, no stream ID could be
   * generated: `closed`, then `error` and `close`, each listener isolated.
   * @see tests/issue/815.test.ts "a channel waiting for an ID closes with OperationError when none is left"
   * @see tests/issue/815.test.ts "close still fires when error listeners throw"
   * @see tests/issue/815.test.ts "every error subscriber is notified even if one throws"
   */
  failWithError(error: Error) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    const onError = (e: unknown) => log("subscriber failed", e);
    this.stateChange.executeIsolated(onError, "closed");
    this.stateChanged.executeIsolated(onError, "closed");
    this.error.executeIsolated((e) => log("error subscriber failed", e), error);
    notifySafely(log, "onerror", () => this.onerror?.({ error }));
    // Test: tests/issue/815.test.ts "a channel failing for lack of an ID without any listener throws nothing"
    this.emitIsolated((e) => log("error listener failed", e), "error", {
      error,
    });
    notifySafely(log, "onclose", () => this.onclose?.());
    this.emitIsolated((e) => log("close listener failed", e), "close");
    log("failed", error.message);
  }

  /**
   * Internal. Every listener is isolated (DOM event semantics).
   * `notifyClosing: false` (a local close()) moves to `closing` with only
   * the stateChange / stateChanged Events, without `closing` / `onclosing`.
   * @see tests/issue/815.test.ts "a throwing close listener of a registered channel skips no listener, channel or teardown"
   * @see tests/issue/815.test.ts "pc.close() closes every pending channel even if a close listener throws"
   */
  setReadyState(
    state: DCState,
    { notifyClosing = true }: { notifyClosing?: boolean } = {},
  ) {
    if (state !== this.readyState) {
      this.readyState = state;
      const onError = (e: unknown) => log("state listener failed", state, e);
      this.stateChange.executeIsolated(onError, state);
      this.stateChanged.executeIsolated(onError, state);

      switch (state) {
        case "open":
          notifySafely(log, "onopen", () => this.onopen?.());
          this.emitIsolated(onError, "open");
          break;
        case "closed":
          notifySafely(log, "onclose", () => this.onclose?.());
          this.emitIsolated(onError, "close");
          break;
        case "closing":
          // W3C webrtc-pc: `closing` fires when the transport starts closing
          // the channel (the peer reset the stream), not on close().
          // Test: tests/datachannel/closeDelivery.test.ts "closing fires on the end the peer closed, not on the end calling close()"
          if (!notifyClosing) break;
          notifySafely(log, "onclosing", () => this.onclosing?.());
          this.emitIsolated(onError, "closing");
          break;
      }
      log("change state", state);
    }
  }

  /**
   * @internal
   * @deprecated Internal bookkeeping, removed in v0.30.0. Send an empty
   * message with `send("")` / `send(Buffer.alloc(0))` instead of queuing it
   * by hand; {@link RTCDataChannel.bufferedAmount} is maintained by werift.
   */
  addBufferedAmount(amount: number) {
    this.changeBufferedAmount(amount, true);
  }

  /**
   * @internal
   * Add (positive) or subtract (negative) bytes and notify a downward
   * crossing of the threshold; a `closed` channel is not notified unless
   * `notifyClosed` (the legacy {@link RTCDataChannel.addBufferedAmount}).
   * @see tests/datachannel/bufferedAmount.test.ts
   */
  changeBufferedAmount(amount: number, notifyClosed = false) {
    const crossesThreshold =
      this._bufferedAmount > this.bufferedAmountLowThreshold &&
      this._bufferedAmount + amount <= this.bufferedAmountLowThreshold;
    this._bufferedAmount += amount;
    if (crossesThreshold && (notifyClosed || this.readyState !== "closed")) {
      // Test: tests/issue/815.notification.test.ts "bufferedamountlow: later listeners run and sending continues"
      const onError = (e: unknown) =>
        log("bufferedamountlow listener failed", e);
      this.bufferedAmountLow.executeIsolated(onError);
      notifySafely(log, "onbufferedamountlow", () =>
        this.onbufferedamountlow?.(),
      );
      this.emitIsolated(onError, "bufferedamountlow");
    }
  }

  /**
   * Queue a message. While `connecting` it waits until the channel can send
   * (werift convenience; W3C throws). On a `closing` / `closed` channel it is
   * ignored (nothing is counted or sent).
   *
   * {@link RTCDataChannel.bufferedAmount} grows by the UTF-8 / byte length.
   * An empty string or buffer is sent as an empty message (RFC 8831 6.6,
   * PPID 56 / 57) that arrives as `""` / an empty Buffer in order with the
   * other messages; it adds nothing to `bufferedAmount` or `bytesSent`, and
   * one to `messagesSent`.
   * @throws Error when the message is larger than the peer's max-message-size.
   * @see tests/datachannel/bufferedAmount.test.ts
   */
  send(data: Buffer | string) {
    if (this.readyState === "closing" || this.readyState === "closed") {
      log("send on a", this.readyState, "data channel, ignored");
      return;
    }
    const size = this.sctp.datachannelSend(this, data);
    this.messagesSent++;
    this.bytesSent += size;
  }

  /**
   * Start the closing procedure (W3C webrtc-pc, RFC 8831 6.7): `closing`
   * now, `close` once both directions of the stream are reset.
   *
   * Every message passed to {@link RTCDataChannel.send} before `close()` is
   * kept, even while the association is still being established, and handed
   * to SCTP before the stream reset; the reset carries the last TSN assigned
   * (RFC 6525), and the peer resets only after it received everything up to
   * it. So on a reliable channel, once `close` fires on this side every such
   * message has reached the peer, without waiting on `bufferedAmount` first.
   * A partially reliable channel may lose what PR-SCTP abandoned.
   *
   * `RTCPeerConnection.close()` aborts the association: what is not delivered
   * yet is lost. To deliver everything, wait for each channel's `close` event
   * before closing the PeerConnection.
   *
   * werift deliberately has no non-standard "unacknowledged amount" API:
   * the guarantee above covers "everything sent before close arrives".
   *
   * An in-band channel whose DATA_CHANNEL_OPEN was not sent yet (the peer
   * does not know it) closes at once and sends nothing.
   * @see tests/datachannel/closeDelivery.test.ts
   */
  close() {
    this.sctp.dataChannelClose(this);
  }
}

export type DCState = "open" | "closed" | "connecting" | "closing";

export class RTCDataChannelParameters {
  label = "";
  /** Lifetime in milliseconds (RFC 8832 / WebRTC). */
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  ordered = true;
  protocol = "";
  negotiated = false;
  id!: number;
  constructor(props: Partial<RTCDataChannelParameters> = {}) {
    Object.assign(this, props);
  }
}

export interface MessageEvent {
  data: string | Buffer;
}

export interface RTCErrorEvent {
  error: any;
}
