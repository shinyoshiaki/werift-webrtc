import { randomUUID } from "crypto";
import { createWebRtcTypeError } from "./errors";
import { EventTarget, notifySafely } from "./helper";
import { debug, Event } from "./imports/common";
import type { RTCSctpTransport } from "./transport/sctp";
import type { CallbackWithValue, EventHandler } from "./types/util";
import { toEnum } from "./webidl";

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

/**
 * The form a received binary message takes in `onmessage` and the
 * `"message"` event (W3C `RTCDataChannel.binaryType`).
 * - `"nodebuffer"`: a Node.js `Buffer` (werift extension, the core default;
 *   named after the `ws` library's value).
 * - `"arraybuffer"`: an `ArrayBuffer` (the W3C default, used by
 *   `werift/polyfill`).
 * - `"blob"`: a `Blob`.
 *
 * Text messages are always strings. {@link RTCDataChannel.onMessage} always
 * receives a `Buffer` or a string.
 * @enum
 */
export const RTCDataChannelBinaryType = {
  nodebuffer: "nodebuffer",
  arraybuffer: "arraybuffer",
  blob: "blob",
} as const;
export type RTCDataChannelBinaryType =
  (typeof RTCDataChannelBinaryType)[keyof typeof RTCDataChannelBinaryType];

export const RTCDataChannelBinaryTypes: readonly RTCDataChannelBinaryType[] =
  Object.values(RTCDataChannelBinaryType);

/** What `onmessage` / the `"message"` event carries, by `binaryType`. */
export type RTCDataChannelMessageData = string | Buffer | ArrayBuffer | Blob;

/**
 * @internal
 * Convert a received message to the form of `binaryType`. Strings stay
 * strings; `"arraybuffer"` copies, so the Buffer pool is never exposed.
 */
export function convertDataChannelMessage(
  data: string | Buffer,
  binaryType: RTCDataChannelBinaryType,
): RTCDataChannelMessageData {
  if (typeof data === "string") return data;
  switch (binaryType) {
    case "arraybuffer":
      return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
    case "blob":
      // Received data is never backed by a SharedArrayBuffer; Blob copies it.
      return new Blob([data as Uint8Array<ArrayBuffer>]);
    default:
      return data;
  }
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
   * W3C `bufferedamountlow`.
   * @see tests/datachannel/bufferedAmount.test.ts "bufferedamountlow fires once per downward crossing, through every notification"
   * @see tests/datachannel/bufferedAmount.test.ts "pc.close() keeps bufferedAmount and fires no bufferedamountlow"
   */
  readonly bufferedAmountLow = new Event();
  /** @see tests/datachannel/bufferedAmount.test.ts "every event handler receives the same Event object as the listeners" */
  onopen?: EventHandler<globalThis.Event>;
  /** @see tests/datachannel/bufferedAmount.test.ts "every event handler receives the same Event object as the listeners" */
  onclose?: EventHandler<globalThis.Event>;
  /** @see tests/datachannel/bufferedAmount.test.ts "every event handler receives the same Event object as the listeners" */
  onclosing?: EventHandler<globalThis.Event>;
  /**
   * W3C `onbufferedamountlow`.
   * @see tests/datachannel/bufferedAmount.test.ts "bufferedamountlow fires once per downward crossing, through every notification"
   * @see tests/datachannel/bufferedAmount.test.ts "onbufferedamountlow receives the same Event object as the bufferedamountlow listeners"
   */
  onbufferedamountlow?: EventHandler<globalThis.Event>;
  onmessage?: CallbackWithValue<MessageEvent>;
  // todo impl
  onerror?: CallbackWithValue<RTCErrorEvent>;
  isCreatedByRemote = false;
  id: number;
  readyState: DCState = "connecting";

  private _bufferedAmount = 0;
  private _bufferedAmountLowThreshold = 0;
  private _binaryType: RTCDataChannelBinaryType;

  // Statistics
  messagesSent = 0;
  bytesSent = 0;
  messagesReceived = 0;
  bytesReceived = 0;

  constructor(
    sctp: RTCSctpTransport,
    parameters: RTCDataChannelParameters,
    sendOpen = true,
    binaryType: RTCDataChannelBinaryType = "nodebuffer",
  ) {
    super();
    this.sctp = sctp;
    this._binaryType = binaryType;
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
   * W3C `binaryType`. The initial value is the PeerConnection's
   * `dataChannelBinaryType` (`"nodebuffer"` by default, `"arraybuffer"`
   * through `werift/polyfill`). Assignment follows the WebIDL enum
   * attribute setter: the value is converted with `ToString` first (an
   * object's `toString()` is used, a Symbol is a `TypeError`), and a result
   * that is not a {@link RTCDataChannelBinaryType} is ignored without an
   * exception (WPT `RTCDataChannel-binaryType.window.js`).
   */
  get binaryType(): RTCDataChannelBinaryType {
    return this._binaryType;
  }

  set binaryType(value: RTCDataChannelBinaryType) {
    const binaryType = toEnum(
      value,
      RTCDataChannelBinaryTypes,
      "RTCDataChannel.binaryType",
    );
    if (binaryType !== undefined) this._binaryType = binaryType;
  }

  /**
   * W3C webrtc-pc `bufferedAmount`.
   * @see tests/datachannel/bufferedAmount.test.ts "is read-only"
   * @see tests/datachannel/bufferedAmount.test.ts "send() adds the UTF-8 byte length synchronously"
   * @see tests/datachannel/bufferedAmount.test.ts "with loss every message arrives and bufferedAmount reaches 0 before the ACK"
   * @see tests/datachannel/bufferedAmount.test.ts "messages abandoned by maxPacketLifeTime before they were sent are subtracted and notified"
   * @see tests/datachannel/bufferedAmount.test.ts "close() does not decrease bufferedAmount immediately; it drains while closing"
   * @see tests/datachannel/bufferedAmount.test.ts "pc.close() keeps bufferedAmount and fires no bufferedamountlow"
   * @see tests/transport/sctp.test.ts "stop discards unsent messages and keeps them in bufferedAmount"
   */
  get bufferedAmount() {
    return this._bufferedAmount;
  }

  /**
   * W3C webrtc-pc `bufferedAmountLowThreshold`.
   * @see tests/datachannel/bufferedAmount.test.ts "a threshold reached exactly notifies once; a threshold raised above the amount does not notify"
   * @see tests/datachannel/bufferedAmount.test.ts "bufferedAmountLowThreshold defaults to 0 and accepts only 0..2^32-1"
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
    this.fireEvent("close", (e) => log("close listener failed", e));
    log("failed", error.message);
  }

  /**
   * Internal. Every listener is isolated (DOM event semantics).
   * @see tests/datachannel/closeDelivery.test.ts "closing fires on the end the peer closed, not on the end calling close()"
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
          this.fireEvent("open", onError);
          break;
        case "closed":
          this.fireEvent("close", onError);
          break;
        case "closing":
          // Test: tests/datachannel/closeDelivery.test.ts "closing fires on the end the peer closed, not on the end calling close()"
          if (!notifyClosing) break;
          this.fireEvent("closing", onError);
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
   * @see tests/datachannel/bufferedAmount.test.ts "pc.close() keeps bufferedAmount and fires no bufferedamountlow"
   * @see tests/datachannel/bufferedAmount.test.ts "the deprecated addBufferedAmount() still notifies on a closed channel"
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
      this.fireEvent("bufferedamountlow", onError);
    }
  }

  /**
   * @see tests/datachannel/bufferedAmount.test.ts "every event handler receives the same Event object as the listeners"
   * @see tests/datachannel/bufferedAmountLow.test.ts "onbufferedamountlow receives the same bufferedamountlow Event as the listeners"
   */
  private fireEvent(
    type: "open" | "close" | "closing" | "bufferedamountlow",
    onError: (error: unknown) => void,
  ) {
    const event = new globalThis.Event(type);
    const name = `on${type}` as const;
    // Not dispatched through a DOM EventTarget, so `bufferedamountlow` points
    // target / currentTarget at this channel itself.
    const setEventProperty = (
      key: "target" | "currentTarget",
      value: this | null,
    ) =>
      Object.defineProperty(event, key, {
        configurable: true,
        enumerable: true,
        value,
      });
    const hasTarget = type === "bufferedamountlow";
    if (hasTarget) {
      setEventProperty("target", this);
      setEventProperty("currentTarget", this);
    }
    notifySafely(log, name, () => this[name]?.(event));
    this.emitIsolated(onError, type, event);
    // DOM: currentTarget is null once dispatch has finished.
    if (hasTarget) setEventProperty("currentTarget", null);
  }

  /**
   * Queue a message. While `connecting` it waits until the channel can send
   * (werift convenience; W3C throws).
   * @throws Error when the message is larger than the peer's max-message-size.
   * @see tests/datachannel/closeDelivery.test.ts "messages sent before close() while connecting reach the peer, then both ends close"
   * @see tests/datachannel/bufferedAmount.test.ts "send() adds the UTF-8 byte length synchronously"
   * @see tests/datachannel/bufferedAmount.test.ts "send() on a closing or closed channel is ignored"
   * @see tests/datachannel/bufferedAmount.test.ts "empty string and empty Buffer arrive in order, bufferedAmount stays 0, stats count them"
   * @see tests/integrate/peerConnection.test.ts "respects remote max-message-size advertised in answer"
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
   * Start the closing procedure (W3C webrtc-pc, RFC 8831 6.7).
   * @see tests/datachannel/closeDelivery.test.ts "close() right after a burst (%o): every message arrives in order before close fires on the sender"
   * @see tests/datachannel/closeDelivery.test.ts "messages sent before close() while connecting reach the peer, then both ends close"
   * @see tests/datachannel/closeDelivery.test.ts "pc.close() before the association is established closes the channel and drops its messages"
   * @see tests/datachannel/closeDelivery.test.ts "an in-band channel closed before its DATA_CHANNEL_OPEN is sent closes at once and sends nothing"
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
  /** `"message"` on received messages. */
  readonly type?: string;
  /**
   * A string for a text message; a binary message by the channel's
   * `binaryType` (`Buffer` by default). Use {@link RTCDataChannel.onMessage}
   * for code that always wants a `Buffer` or a string.
   */
  data: RTCDataChannelMessageData;
}

export interface RTCErrorEvent {
  error: any;
}
