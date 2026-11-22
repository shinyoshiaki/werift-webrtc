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

/** @internal */
export function isRTCDataChannelBinaryType(
  value: unknown,
): value is RTCDataChannelBinaryType {
  return RTCDataChannelBinaryTypes.includes(value as RTCDataChannelBinaryType);
}

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
  readonly bufferedAmountLow = new Event();
  onopen?: Callback;
  /** W3C `onbufferedamountlow`. See {@link RTCDataChannel.bufferedAmountLowThreshold}. */
  onbufferedamountlow?: Callback;
  onclose?: Callback;
  onclosing?: Callback;
  onmessage?: CallbackWithValue<MessageEvent>;
  // todo impl
  onerror?: CallbackWithValue<RTCErrorEvent>;
  isCreatedByRemote = false;
  id: number;
  readyState: DCState = "connecting";

  bufferedAmount = 0;
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
   * through `werift/polyfill`). A value that is not a
   * {@link RTCDataChannelBinaryType} is ignored (WebIDL enum attribute).
   */
  get binaryType(): RTCDataChannelBinaryType {
    return this._binaryType;
  }

  set binaryType(value: RTCDataChannelBinaryType) {
    if (isRTCDataChannelBinaryType(value)) this._binaryType = value;
  }

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
   * @see tests/issue/815.test.ts "a throwing close listener of a registered channel skips no listener, channel or teardown"
   * @see tests/issue/815.test.ts "pc.close() closes every pending channel even if a close listener throws"
   */
  setReadyState(state: DCState) {
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
          notifySafely(log, "onclosing", () => this.onclosing?.());
          break;
      }
      log("change state", state);
    }
  }

  /**
   * Internal: add to `bufferedAmount` (a negative `amount` when a message
   * left the buffer). Only data that was sent (`sent`, the default) can
   * fire `bufferedamountlow` (W3C: "as a result of sending data"); data
   * discarded unsent only leaves the buffer, so a low listener that sends
   * again on a closed channel cannot loop.
   * @see tests/datachannel/bufferedAmountLow.test.ts "a low listener sending on the channel it closed does not loop"
   * @see tests/datachannel/bufferedAmountLow.test.ts "every surface is notified once per crossing, in the order of the other channel events"
   */
  addBufferedAmount(amount: number, { sent = true }: { sent?: boolean } = {}) {
    const crossesThreshold =
      this.bufferedAmount > this.bufferedAmountLowThreshold &&
      this.bufferedAmount + amount <= this.bufferedAmountLowThreshold;
    this.bufferedAmount += amount;
    if (crossesThreshold && sent) this.notifyBufferedAmountLow();
  }

  /**
   * `bufferedAmountLow`, `onbufferedamountlow`, then the
   * `"bufferedamountlow"` event, synchronously when the threshold is
   * crossed (the order of setReadyState). Every listener is isolated, so
   * the flush loop, stop() and later listeners continue.
   * @see tests/issue/815.notification.test.ts "bufferedamountlow: later listeners run and sending continues"
   */
  private notifyBufferedAmountLow() {
    const onError = (e: unknown) => log("bufferedamountlow listener failed", e);
    this.bufferedAmountLow.executeIsolated(onError);
    notifySafely(log, "onbufferedamountlow", () =>
      this.onbufferedamountlow?.(),
    );
    this.emitIsolated(onError, "bufferedamountlow");
  }

  send(data: Buffer | string) {
    const size = this.sctp.datachannelSend(this, data);
    this.messagesSent++;
    this.bytesSent += size;
  }

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
