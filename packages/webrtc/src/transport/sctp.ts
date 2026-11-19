import { randomUUID } from "crypto";
import {
  SCTP,
  SCTP_STATE,
  type SCTPOptions,
  type Transport,
} from "../../../sctp/src";
import {
  DATA_CHANNEL_ACK,
  DATA_CHANNEL_OPEN,
  DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT,
  DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED,
  DATA_CHANNEL_PARTIAL_RELIABLE_TIMED,
  DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED,
  DATA_CHANNEL_RELIABLE,
  DATA_CHANNEL_RELIABLE_UNORDERED,
  WEBRTC_BINARY,
  WEBRTC_BINARY_EMPTY,
  WEBRTC_DCEP,
  WEBRTC_STRING,
  WEBRTC_STRING_EMPTY,
} from "../const";
import {
  type DCState,
  getDataChannelMessageSize,
  RTCDataChannel,
  RTCDataChannelParameters,
} from "../dataChannel";
import { createWebRtcDomException } from "../errors";
import { EventTarget as DomEventTarget, notifySafely } from "../helper";
import { debug, Event, FifoQueue } from "../imports/common";
import type { RTCDtlsTransport } from "./dtls";

const log = debug("werift:packages/webrtc/src/transport/sctp.ts");
export const DEFAULT_MAX_MESSAGE_SIZE = 65536;
/** Stream IDs a data channel may use: 0..65534 (W3C webrtc-pc, RFC 8831 section 6.5). */
const DATA_CHANNEL_ID_LIMIT = 65535;

/** Which direction of a closing channel's stream is reset (RFC 8831 6.7). */
interface ClosingStream {
  outgoing: boolean;
  incoming: boolean;
  /** Closes the channel if the peer never resets its side. */
  fallback?: ReturnType<typeof setTimeout>;
}

/** W3C webrtc-pc `RTCSctpTransportState`. */
export type RTCSctpTransportState = "connecting" | "connected" | "closed";

export class RTCSctpTransport {
  public port: number;
  public maxMessageSize: number;
  private readonly sctpOptions: SCTPOptions;

  dtlsTransport!: RTCDtlsTransport;
  sctp!: SCTP;

  readonly onDataChannel = new Event<[RTCDataChannel]>();
  readonly id = randomUUID().toString();
  /**
   * `connecting` until the association is established, then `connected`;
   * `closed` once the association closed (the peer ended it, or the DTLS
   * transport closed / failed). {@link RTCSctpTransport.stop} (e.g.
   * `RTCPeerConnection.close()`) moves to `closed` without statechange.
   * A new association (renegotiation) starts again from `connecting`.
   */
  state: RTCSctpTransportState = "connecting";
  readonly onStateChange = new Event<[RTCSctpTransportState]>();
  onstatechange?: (() => void) | undefined;
  private readonly events = new DomEventTarget();

  mid?: string;
  mLineIndex?: number;
  bundled = false;
  dataChannels: { [key: number]: RTCDataChannel } = {};
  /** Set by stop(); nothing received afterwards reaches the application. */
  private stopped = false;
  remoteMaxMessageSize = DEFAULT_MAX_MESSAGE_SIZE;

  private dataChannelQueue = new FifoQueue<[RTCDataChannel, number, Buffer]>();
  /**
   * In-band channels created on this side whose DATA_CHANNEL_OPEN is not
   * handed to SCTP yet, in creation order. Their stream ID, if any, is a
   * reservation: it is released when the association is discarded or the
   * DTLS role changes, and taken again from the role in force.
   */
  private readonly unannounced = new Set<RTCDataChannel>();
  private eventDisposer: (() => void)[] = [];
  /**
   * Streams of closing channels and which direction of the RFC 8831 section
   * 6.7 reset is done. The channel keeps its stream ID until both are, so a
   * channel reusing the ID never meets a reset of the closed one.
   */
  private readonly closingStreams = new Map<number, ClosingStream>();
  /**
   * @internal
   * How long a channel whose outgoing stream is reset waits for the peer to
   * reset its side before it closes anyway: older werift resets only a stream
   * it sent ordered data on. A peer that does reset sends its request with
   * its response to ours; 5 s covers one retransmission of a lost request
   * (SCTP RTO.Initial 3 s, RFC 9260 section 16) and keeps the `close` of a
   * channel to older werift at most 5 s late.
   */
  reverseResetTimeout = 5_000;
  /**
   * Streams of channels closed by {@link RTCSctpTransport.reverseResetTimeout}
   * whose peer reset never came: in use until it does (or the association
   * ends), for automatic IDs and negotiated channels alike.
   */
  private readonly awaitingPeerReset = new Set<number>();

  constructor(
    port = 5000,
    maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE,
    sctpOptions: SCTPOptions = {},
  ) {
    this.port = port;
    this.maxMessageSize = maxMessageSize;
    this.sctpOptions = sctpOptions;
  }

  get transport() {
    return this.dtlsTransport;
  }

  addEventListener = (
    type: string,
    listener: (...args: any[]) => void,
    options?: boolean | { once?: boolean },
  ) => {
    this.events.addEventListener(type, listener, options);
  };

  removeEventListener = (type: string, listener: (...args: any[]) => void) => {
    this.events.removeEventListener(type, listener);
  };

  /**
   * Change the state and notify. Each notification is isolated: an
   * exception a listener throws is logged and never interrupts the caller
   * (stop() and its ABORT, closing the data channels).
   */
  private setState(state: RTCSctpTransportState, emitEvent = true) {
    if (state === this.state) return;
    this.state = state;
    // Per subscriber, so a throwing subscriber cannot skip a later one.
    this.onStateChange.executeIsolated(
      (error) => log("onStateChange listener failed", error),
      state,
    );
    if (emitEvent) {
      notifySafely(log, "onstatechange", () => this.onstatechange?.());
      this.events.emitIsolated(
        (error) => log("statechange listener failed", error),
        "statechange",
      );
    }
  }

  setDtlsTransport(dtlsTransport: RTCDtlsTransport) {
    if (this.dtlsTransport && this.dtlsTransport.id === dtlsTransport.id) {
      return;
    }
    this.bindAssociation(dtlsTransport);
  }

  /**
   * @internal
   * Discard the current association (ABORT, attached channels close) and
   * bind a new, unstarted one (on the same DTLS transport by default).
   * Channels whose DATA_CHANNEL_OPEN was not sent yet give their stream ID
   * back and stay queued; the next negotiation that decides the DTLS role
   * assigns them again ({@link RTCSctpTransport.assignPendingStreamIds}).
   */
  async resetAssociation(dtlsTransport = this.dtlsTransport) {
    // Before stop(): the closed association closes every registered channel.
    this.releaseUnannouncedStreamIds();
    await this.stop();
    this.dataChannelQueue = this.dataChannelQueue.filter(([channel]) =>
      this.unannounced.has(channel),
    );
    this.bindAssociation(dtlsTransport, { assignIds: false });
  }

  /**
   * @internal
   * The association left its initial state (started, or established passively).
   */
  get associationActive() {
    return (
      this.sctp.started ||
      this.sctp.state !== "new" ||
      this.sctp.associationState !== SCTP_STATE.CLOSED
    );
  }

  /**
   * `assignIds`: unannounced channels take stream IDs from the role of the
   * bound DTLS transport at once (a BUNDLE move keeps a decided role). A
   * reset association leaves them waiting for the next negotiation.
   */
  private bindAssociation(
    dtlsTransport: RTCDtlsTransport,
    { assignIds = true }: { assignIds?: boolean } = {},
  ) {
    this.eventDisposer.forEach((dispose) => dispose());
    // Resets of the previous association never arrive on this one.
    this.clearClosingStreams();

    this.dtlsTransport = dtlsTransport;
    // A new association: the transport delivers again.
    this.stopped = false;
    this.setState("connecting", false);
    this.sctp = new SCTP(
      new BridgeDtls(this.dtlsTransport),
      this.port,
      this.sctpOptions,
    );

    this.eventDisposer = [
      ...[
        this.sctp.onReceive.subscribe(this.datachannelReceive),
        this.sctp.onReconfigStreams.subscribe((ids, direction) =>
          this.onStreamsReset(ids, direction),
        ),
        this.sctp.stateChanged.connected.subscribe(() => {
          this.setState("connected");
          Object.values(this.dataChannels).forEach((channel) => {
            if (channel.negotiated && channel.readyState !== "open") {
              channel.setReadyState("open");
            }
          });
          this.dataChannelFlush();
        }),
        this.sctp.stateChanged.closed.subscribe(() => {
          if (!this.stopped) this.setState("closed");
          this.clearClosingStreams();
          // Every registered channel closes, also one with a reserved ID
          // (resetAssociation gives those back first to keep them).
          // setReadyState isolates the listeners, so a throwing one skips
          // neither the other channels nor the rest of stop().
          const channels = Object.values(this.dataChannels);
          this.dataChannels = {};
          // A reserved channel closes too: its queued OPEN must not stay.
          const closing = new Set(channels);
          this.dataChannelQueue = this.dataChannelQueue.filter(
            ([queued]) => !closing.has(queued),
          );
          for (const dc of channels) {
            this.unannounced.delete(dc);
            dc.setReadyState("closed");
          }
        }),
        // DTLS closed (close_notify from the peer) or failed (a fatal
        // alert): the association and its data channels close. A stopped
        // transport is left to stop(): RTCPeerConnection.close() marks DTLS
        // closed synchronously, before stop() sends the SCTP ABORT, and
        // closing the association here would skip that ABORT.
        this.dtlsTransport.onStateChange.subscribe((state) => {
          if (this.stopped) return;
          if (state === "closed" || state === "failed") {
            this.sctp.setState(SCTP_STATE.CLOSED);
          }
        }),
        // A DTLS role decided (or changed) by a description or by the
        // handshake start: unannounced channels take IDs of its parity now,
        // before the description's promise resolves (W3C webrtc-pc 4.4.1.6).
        this.dtlsTransport.onRoleChange.subscribe(() => {
          this.releaseUnannouncedStreamIds();
          this.assignPendingStreamIds();
        }),
      ].map((e) => e.unSubscribe),
      () => (this.sctp.onSackReceived = async () => {}),
    ];

    this.sctp.onSackReceived = async () => {
      this.dataChannelFlush();
    };
    if (assignIds) {
      this.releaseUnannouncedStreamIds();
      this.assignPendingStreamIds();
    }
  }

  /**
   * RFC 8831 section 6.7: a channel closes when both directions of its
   * stream are reset. The first reset (ours or the peer's) starts the close
   * (`closing`); a reset of the peer's stream is answered with ours, whatever
   * data went over the stream. The ID is released before `closed` fires, so
   * a `close` listener may create a channel on it at once (W3C: ids are
   * reusable after the close event), and no reset of the closed channel is
   * left to arrive.
   */
  private onStreamsReset(ids: number[], direction: "outgoing" | "incoming") {
    for (const id of ids) {
      if (direction === "incoming" && this.awaitingPeerReset.delete(id)) {
        // The late reset of a channel closed by `reverseResetTimeout`: our
        // side is reset already, so SCTP's reverse reset is dropped, and
        // the ID is free again now that both directions are.
        this.sctp.reconfigQueue = this.sctp.reconfigQueue.filter(
          (streamId) => streamId !== id,
        );
        continue;
      }
      // No channel: a stream reset to reject the peer's OPEN on it.
      const dc = this.dataChannels[id];
      if (!dc) continue;
      let reset = this.closingStreams.get(id);
      if (!reset) {
        reset = { outgoing: false, incoming: false };
        this.closingStreams.set(id, reset);
      }
      reset[direction] = true;
      if (dc.readyState !== "closing") {
        dc.setReadyState("closing");
        // A `closing` listener may have closed the transport meanwhile.
        if (this.dataChannels[id] !== dc || dc.readyState === "closed") {
          continue;
        }
      }
      if (direction === "incoming") this.answerIncomingReset(id, reset);
      this.completeClose(id, dc, reset);
    }
  }

  /** Reset our side of a stream the peer reset, exactly once. */
  private answerIncomingReset(id: number, reset: ClosingStream) {
    const inFlight = !!this.sctp.reconfigRequest?.streams.includes(id);
    if (reset.outgoing || inFlight) {
      // SCTP queues a reverse reset for a stream with ordered data even when
      // ours is in flight; a second one would reset the stream's next channel.
      this.sctp.reconfigQueue = this.sctp.reconfigQueue.filter(
        (streamId) => streamId !== id,
      );
      return;
    }
    // Queued by our close() or by SCTP (ordered data), or not yet at all
    // (no data, or only unordered data, went over the stream).
    this.resetStream(id);
  }

  private completeClose(id: number, dc: RTCDataChannel, reset: ClosingStream) {
    if (reset.outgoing && reset.incoming) {
      clearTimeout(reset.fallback);
      this.closingStreams.delete(id);
      delete this.dataChannels[id];
      this.unannounced.delete(dc);
      dc.setReadyState("closed");
    } else if (reset.outgoing && !reset.fallback) {
      reset.fallback = setTimeout(() => {
        if (this.closingStreams.get(id) !== reset) return;
        log("the peer did not reset its side of the stream", id);
        // The channel closes, but its stream is not reusable (RFC 8831
        // section 6.7) until the peer's reset arrives: it may come late and
        // would then close a channel created on the ID.
        this.awaitingPeerReset.add(id);
        reset.incoming = true;
        this.completeClose(id, dc, reset);
      }, this.reverseResetTimeout);
      reset.fallback.unref?.();
    }
  }

  private clearClosingStreams() {
    for (const { fallback } of this.closingStreams.values()) {
      clearTimeout(fallback);
    }
    this.closingStreams.clear();
    // No reset of an ended association arrives on the next one.
    this.awaitingPeerReset.clear();
  }

  /**
   * The SCTP INIT side (`SCTP.isServer`): the ICE role when DTLS started.
   * It is independent of the stream ID parity, which follows the DTLS role.
   */
  private get isServer() {
    const role =
      this.dtlsTransport.iceRoleAtStart ?? this.dtlsTransport.iceTransport.role;
    return role !== "controlling";
  }

  /**
   * RFC 8832 section 6: the DTLS client uses even stream IDs, the DTLS
   * server odd ones. Undefined while the DTLS role is not decided (`auto`):
   * no ID is assigned until it is.
   */
  private get idParity(): 0 | 1 | undefined {
    switch (this.dtlsTransport?.role) {
      case "client":
        return 0;
      case "server":
        return 1;
      default:
        return undefined;
    }
  }

  /** Exclusive upper bound of a stream ID: 65535, or what SCTP negotiated. */
  private get streamIdLimit() {
    const negotiated = this.sctp?.maxChannels;
    return negotiated === undefined
      ? DATA_CHANNEL_ID_LIMIT
      : Math.min(negotiated, DATA_CHANNEL_ID_LIMIT);
  }

  /**
   * The lowest free stream ID of `parity`. Every registered channel is
   * skipped: negotiated ones (also of the other parity), ones the peer
   * opened and ones reserved here. A closed channel is unregistered, so its
   * ID is reused.
   */
  private allocateStreamId(parity: 0 | 1) {
    const limit = this.streamIdLimit;
    for (let id = parity; id < limit; id += 2) {
      if (!this.dataChannels[id] && !this.awaitingPeerReset.has(id)) return id;
    }
    return undefined;
  }

  /**
   * @internal
   * Reserve a stream ID for every unannounced channel without one, from the
   * DTLS role (nothing while it is `auto`). A channel for which no ID is left
   * closes with an `OperationError` (W3C webrtc-pc 4.4.1.6 step 2.2.6).
   */
  assignPendingStreamIds() {
    const parity = this.idParity;
    if (parity === undefined) return;
    const limit = this.streamIdLimit;
    for (const channel of [...this.unannounced]) {
      // An error callback of an earlier channel may have closed this one.
      if (
        !this.unannounced.has(channel) ||
        channel.readyState === "closed" ||
        channel.readyState === "closing"
      ) {
        continue;
      }
      if (channel.id != undefined) {
        // A reservation made before SCTP negotiated fewer streams is out of
        // range: give it back and allocate again below.
        if (channel.id < limit) continue;
        if (this.dataChannels[channel.id] === channel) {
          delete this.dataChannels[channel.id];
        }
        channel.setId(undefined);
      }
      const id = this.allocateStreamId(parity);
      if (id === undefined) {
        this.unannounced.delete(channel);
        this.dataChannelQueue = this.dataChannelQueue.filter(
          ([queued]) => queued !== channel,
        );
        channel.failWithError(
          createWebRtcDomException(
            "OperationError",
            "No data channel stream ID is available",
          ),
        );
        continue;
      }
      this.dataChannels[id] = channel;
      channel.setId(id);
    }
  }

  /**
   * @internal
   * Give back the reservations of unannounced channels; they wait for the
   * next {@link RTCSctpTransport.assignPendingStreamIds}.
   */
  releaseUnannouncedStreamIds() {
    for (const channel of this.unannounced) {
      if (channel.id == undefined) continue;
      if (this.dataChannels[channel.id] === channel) {
        delete this.dataChannels[channel.id];
      }
      channel.setId(undefined);
    }
  }

  channelByLabel(label: string) {
    return Object.values(this.dataChannels).find((d) => d.label === label);
  }

  private datachannelReceive = async (
    streamId: number,
    ppId: number,
    data: Buffer,
  ) => {
    // A stopped transport (rolled back, replaced or closed) delivers no
    // message a callback still queued for it carries.
    if (this.stopped) return;
    if (ppId === WEBRTC_DCEP && data.length > 0) {
      log("DCEP", streamId, ppId, data);
      switch (data[0]) {
        case DATA_CHANNEL_OPEN:
          {
            if (data.length < 12) {
              log("DATA_CHANNEL_OPEN data.length not enough");
              return;
            }

            const existing = this.dataChannels[streamId];
            if (existing && !existing.isCreatedByRemote) {
              // The stream ID is one this side uses (reserved or opened
              // here, or negotiated): the peer violates the parity of its
              // DTLS role, or reuses a stream in use.
              log("DATA_CHANNEL_OPEN on a stream ID in local use, rejected", {
                streamId,
                label: existing.label,
              });
              this.rejectOpenOnStreamInUse(existing);
              return;
            }
            if (!existing && streamId % 2 === this.idParity) {
              // RFC 8832 section 6: the peer must use the other parity of
              // the DTLS role. Not acknowledged; its channel is closed.
              log("DATA_CHANNEL_OPEN violating the odd/even rule, rejected", {
                streamId,
              });
              this.resetStream(streamId);
              return;
            }
            if (!existing) {
              // !BBHLHH — 12 byte DCEP OPEN header (big-endian)
              const channelType = data.readUInt8(1);
              const reliability = data.readUInt32BE(4);
              const labelLength = data.readUInt16BE(8);
              const protocolLength = data.readUInt16BE(10);

              let pos = 12;
              const label = data.slice(pos, pos + labelLength).toString("utf8");
              pos += labelLength;
              const protocol = data
                .slice(pos, pos + protocolLength)
                .toString("utf8");

              log("DATA_CHANNEL_OPEN", {
                channelType,
                reliability,
                streamId,
                label,
                protocol,
              });

              const maxRetransmits =
                (channelType & 0x03) === 1 ? reliability : undefined;
              const maxPacketLifeTime =
                (channelType & 0x03) === 2 ? reliability : undefined;

              // # register channel
              const parameters = new RTCDataChannelParameters({
                label,
                ordered: (channelType & 0x80) === 0,
                maxPacketLifeTime,
                maxRetransmits,
                protocol,
                id: streamId,
              });
              const channel = new RTCDataChannel(this, parameters, false);
              channel.isCreatedByRemote = true;
              this.dataChannels[streamId] = channel;

              // Isolated: a throwing `datachannel` listener must neither skip
              // the open nor the ACK below.
              this.onDataChannel.executeIsolated(
                (error) => log("onDataChannel listener failed", error),
                channel,
              );
              channel.setReadyState("open");
            } else if (existing.readyState !== "open") {
              // The peer's channel on this stream is closing (RFC 8831
              // section 6.7 reset under way): an OPEN on a stream in use is
              // not acknowledged (RFC 8832 section 6), and the close that
              // RFC asks for is already running.
              log("DATA_CHANNEL_OPEN on a closing stream, ignored", streamId);
              return;
            } else {
              log("datachannel already opened", "retransmit ack");
            }

            const channel = this.dataChannels[streamId];
            const ack = Buffer.allocUnsafe(1);
            ack.writeUInt8(DATA_CHANNEL_ACK, 0);
            this.dataChannelQueue.push([channel, WEBRTC_DCEP, ack]);
            this.dataChannelFlush();
          }
          break;
        case DATA_CHANNEL_ACK:
          {
            log("DATA_CHANNEL_ACK", streamId, ppId);
            const channel = this.dataChannels[streamId];
            if (!channel) {
              // Not thrown: this async receive callback has no caller to
              // catch it (an unhandled rejection).
              log(
                "DATA_CHANNEL_ACK for an unknown stream ID, ignored",
                streamId,
              );
              return;
            }
            channel.setReadyState("open");
          }
          break;
      }
    } else {
      const channel = this.dataChannels[streamId];
      if (channel) {
        const msg = (() => {
          switch (ppId) {
            case WEBRTC_STRING:
              return data.toString("utf8");
            case WEBRTC_STRING_EMPTY:
              return "";
            case WEBRTC_BINARY:
              return data;
            case WEBRTC_BINARY_EMPTY:
              return Buffer.from([]);
            default:
              return undefined;
          }
        })();
        if (msg === undefined) {
          log("message with an unknown PPID, ignored", { streamId, ppId });
          return;
        }

        // W3C webrtc-pc "Receiving messages on a data channel" step 3: not
        // `open` (here `closing`: the stream reset is under way) discards the
        // message; libwebrtc does not deliver it either. `connecting` still
        // delivers: unordered data of the peer may overtake its ACK.
        if (
          channel.readyState === "closing" ||
          channel.readyState === "closed"
        ) {
          log("message on a closing data channel, discarded", streamId);
          return;
        }

        // Update reception statistics
        channel.messagesReceived++;
        channel.bytesReceived += data.length;

        // Every listener is isolated (DOM event semantics): a throwing one
        // skips neither the later listeners nor later messages, and is no
        // unhandled rejection of this async callback.
        const onError = (error: unknown) =>
          log("message listener failed", error);
        channel.onMessage.executeIsolated(onError, msg);
        channel.emitIsolated(onError, "message", { data: msg });
        notifySafely(log, "onmessage", () =>
          channel.onmessage?.({ data: msg }),
        );
      }
    }
  };

  dataChannelAddNegotiated(channel: RTCDataChannel) {
    if (channel.id == undefined) {
      throw new Error();
    }
    if (this.dataChannels[channel.id]) {
      throw new Error();
    }
    if (this.awaitingPeerReset.has(channel.id)) {
      // W3C createDataChannel: an ID in use is an OperationError. RFC 8831
      // section 6.7: the stream is reusable once the peer reset its side.
      throw createWebRtcDomException(
        "OperationError",
        `Stream ${channel.id} waits for the peer to reset it`,
      );
    }

    this.dataChannels[channel.id] = channel;

    if (this.sctp.associationState === SCTP_STATE.ESTABLISHED) {
      channel.setReadyState("open");
    }
  }

  dataChannelOpen(channel: RTCDataChannel) {
    // Label / Protocol Length are byte counts of the UTF-8 fields (RFC 8832
    // 5.1), so they come from the encoded buffers, not from string.length.
    // Their 16-bit limit is enforced by the RTCDataChannel constructor.
    const label = Buffer.from(channel.label, "utf8");
    const protocol = Buffer.from(channel.protocol, "utf8");

    // The public entry (`SctpTransportManager.createDataChannel`) drops the
    // `id` of an in-band channel: its ID always comes from the DTLS role.
    if (channel.id != undefined) {
      throw new Error(
        "internal: an in-band data channel gets its stream ID from the DTLS role",
      );
    }
    // With the DTLS role decided the ID is taken at once (W3C webrtc-pc
    // createDataChannel step 19); none left is an OperationError.
    const parity = this.idParity;
    if (parity !== undefined) {
      const id = this.allocateStreamId(parity);
      if (id === undefined) {
        throw createWebRtcDomException(
          "OperationError",
          "No data channel stream ID is available",
        );
      }
      this.dataChannels[id] = channel;
      channel.setId(id);
    }
    this.unannounced.add(channel);

    const priority = 0;
    // RFC 8832 5.1: the reliability mode and the unordered bit (0x80) are
    // independent, so a partially reliable channel keeps its unordered bit.
    let channelType: number;
    let reliability = 0;
    if (channel.maxRetransmits !== null) {
      channelType = channel.ordered
        ? DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT
        : DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED;
      reliability = channel.maxRetransmits;
    } else if (channel.maxPacketLifeTime !== null) {
      channelType = channel.ordered
        ? DATA_CHANNEL_PARTIAL_RELIABLE_TIMED
        : DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED;
      reliability = channel.maxPacketLifeTime;
    } else {
      channelType = channel.ordered
        ? DATA_CHANNEL_RELIABLE
        : DATA_CHANNEL_RELIABLE_UNORDERED;
    }

    // 5.1.  DATA_CHANNEL_OPEN Message
    // !BBHLHH — message type / channel type / priority / reliability / label len / protocol len
    const data = Buffer.allocUnsafe(12);
    data.writeUInt8(DATA_CHANNEL_OPEN, 0);
    data.writeUInt8(channelType, 1);
    data.writeUInt16BE(priority, 2);
    data.writeUInt32BE(reliability, 4);
    data.writeUInt16BE(label.length, 8);
    data.writeUInt16BE(protocol.length, 10);
    const send = Buffer.concat([data, label, protocol]);
    this.dataChannelQueue.push([channel, WEBRTC_DCEP, send]);
    this.dataChannelFlush();
  }

  /**
   * Hand the queued DCEP and user messages to SCTP once the association is
   * established. Sending only: stream IDs are reserved when the DTLS role is
   * decided ({@link RTCSctpTransport.assignPendingStreamIds}); a message of
   * a channel still without one stays queued.
   */
  private dataChannelFlush() {
    if (this.sctp.associationState != SCTP_STATE.ESTABLISHED) return;
    // Established means DTLS ran, so its role is decided.
    this.assignPendingStreamIds();
    const waiting = new FifoQueue<[RTCDataChannel, number, Buffer]>();

    // Hands every queued message to SCTP synchronously (SCTP.send enqueues
    // before its first await) and tracks completion per message, so repeated
    // datachannelSend() calls never spawn concurrent flush loops.
    while (this.dataChannelQueue.length > 0) {
      const [channel, protocol, userData] = this.dataChannelQueue.shift()!;

      // A channel closed while its message was queued (e.g. the association
      // closed and was re-established) is no longer managed; never announce it.
      if (channel.readyState === "closed" || channel.readyState === "closing") {
        if (protocol !== WEBRTC_DCEP)
          channel.addBufferedAmount(-userData.length);
        continue;
      }

      const streamId = channel.id;
      if (streamId == undefined) {
        waiting.push([channel, protocol, userData]);
        continue;
      }

      if (protocol === WEBRTC_DCEP) {
        if (userData[0] === DATA_CHANNEL_OPEN) this.unannounced.delete(channel);
        this.sctp
          .send(streamId, protocol, userData, {
            ordered: true,
          })
          .catch((err: Error) => {
            log("send DCEP failed", err.message);
          });
      } else {
        const expiry =
          channel.maxPacketLifeTime !== null
            ? Date.now() + channel.maxPacketLifeTime
            : undefined;

        this.sctp
          .send(streamId, protocol, userData, {
            expiry,
            maxRetransmits: channel.maxRetransmits ?? undefined,
            ordered: channel.ordered,
          })
          .catch((err: Error) => {
            log("send data failed", err.message);
          })
          .then(() => channel.addBufferedAmount(-userData.length))
          .catch((err: Error) => {
            log("update bufferedAmount failed", err.message);
          });
      }
    }
    if (waiting.length > 0) this.dataChannelQueue = waiting;
  }

  private assertSendableMessageSize(size: number) {
    if (this.remoteMaxMessageSize !== 0 && size > this.remoteMaxMessageSize) {
      throw new Error(
        `max-message-size exceeded: ${size} > ${this.remoteMaxMessageSize}`,
      );
    }
  }

  datachannelSend = (channel: RTCDataChannel, data: Buffer | string) => {
    const userData = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const size = getDataChannelMessageSize(data);

    this.assertSendableMessageSize(size);
    channel.addBufferedAmount(size);

    this.dataChannelQueue.push(
      typeof data === "string"
        ? [channel, WEBRTC_STRING, userData]
        : [channel, WEBRTC_BINARY, userData],
    );

    if (this.sctp.associationState !== SCTP_STATE.ESTABLISHED) {
      log("sctp not established", this.sctp.associationState);
    }

    this.dataChannelFlush();

    return size;
  };

  getCapabilities() {
    return RTCSctpTransport.getCapabilities(this.maxMessageSize);
  }

  static getCapabilities(maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE) {
    return new RTCSctpCapabilities(maxMessageSize);
  }

  setRemoteMaxMessageSize(maxMessageSize?: number) {
    this.remoteMaxMessageSize = maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
  }

  setRemotePort(port: number) {
    this.sctp.setRemotePort(port);
  }

  async start(remotePort: number) {
    this.assignRole();
    await this.sctp.start(remotePort);
  }

  /**
   * @internal
   * Idempotent start: an association that is established (also passively,
   * from the remote INIT), handshaking or closed is not started again, so
   * no second INIT is sent and the state never moves back.
   */
  async ensureStarted(remotePort: number) {
    if (this.sctp.started || this.sctp.state === "closed") return;
    this.assignRole();
    if (this.sctp.state === "connected") return;
    await this.sctp.start(remotePort);
  }

  private assignRole() {
    this.sctp.isServer = this.isServer;
  }

  /**
   * @internal
   * The synchronous part of {@link RTCSctpTransport.stop}: `closed` without
   * statechange, and nothing received afterwards reaches the application.
   * `RTCPeerConnection.close()` calls it before its first await.
   */
  markStopped() {
    this.stopped = true;
    this.setState("closed", false);
  }

  /**
   * @internal
   * `RTCPeerConnection.close()`: close the channels still waiting for a
   * stream ID or an OPEN. They are not in the registry the association close
   * walks. Not part of {@link RTCSctpTransport.stop}, which a rollback or a
   * reset also uses and which keeps these channels for the next negotiation.
   * Called after stop(), like the association close of the registered
   * channels: the `close` listeners see the PeerConnection, the SCTP and the
   * DTLS transports `closed` (`SctpTransportManager.close`).
   */
  closeUnannouncedChannels() {
    const channels = [...this.unannounced];
    this.unannounced.clear();
    this.dataChannelQueue = this.dataChannelQueue.filter(
      ([queued]) => !channels.includes(queued),
    );
    for (const channel of channels) {
      if (
        channel.id != undefined &&
        this.dataChannels[channel.id] === channel
      ) {
        delete this.dataChannels[channel.id];
      }
      // setReadyState isolates the listeners: a throwing one stops neither
      // the remaining channels nor the rest of the PeerConnection teardown.
      channel.setReadyState("closed");
    }
  }

  async stop() {
    this.markStopped();
    this.dtlsTransport.dataReceiver = () => {};
    this.discardUnsentMessages();
    await this.sctp.stop();
  }

  // Messages not yet handed to SCTP belong to the stopped association and must
  // not leak into a later one. User messages are dropped and removed from
  // bufferedAmount; DATA_CHANNEL_OPEN is kept only for channels still alive, so
  // a channel that outlives the transport (e.g. rollback) can be announced,
  // while closed channels and stale ACKs go.
  private discardUnsentMessages() {
    const kept = new FifoQueue<[RTCDataChannel, number, Buffer]>();
    for (const item of this.dataChannelQueue.toArray()) {
      const [channel, protocol, userData] = item;
      if (protocol !== WEBRTC_DCEP) {
        channel.addBufferedAmount(-userData.length);
      } else if (
        userData[0] === DATA_CHANNEL_OPEN &&
        channel.readyState !== "closed" &&
        channel.readyState !== "closing"
      ) {
        kept.push(item);
      }
    }
    this.dataChannelQueue = kept;
    for (const channel of this.unannounced) {
      if (channel.readyState === "closed" || channel.readyState === "closing") {
        this.unannounced.delete(channel);
      }
    }
  }

  /**
   * RFC 8832 section 6: a DATA_CHANNEL_OPEN on a stream already in use is
   * not acknowledged, and the data channel of that stream is closed by
   * resetting its outgoing stream (RFC 8831 section 6.7). The peer's channel
   * then sees the reset before any ACK (a failed open) and closes; the local
   * channel on the stream closes too once the peer resets its side, as both
   * ends claim the stream. One whose OPEN is still queued is not announced.
   */
  /**
   * Close the peer's data channel on a stream no local channel uses: reset
   * the outgoing stream (RFC 8831 section 6.7). The peer sees the reset
   * before any ACK (a failed open), closes its channel and resets its side;
   * nothing is registered here for it.
   */
  private resetStream(streamId: number) {
    if (!this.sctp.reconfigQueue.includes(streamId)) {
      this.sctp.reconfigQueue.push(streamId);
    }
    if (this.sctp.reconfigQueue.length === 1) {
      this.sctp.transmitReconfigRequest();
    }
  }

  private rejectOpenOnStreamInUse(channel: RTCDataChannel) {
    if (this.unannounced.delete(channel)) {
      this.dataChannelQueue = this.dataChannelQueue.filter(
        ([queued]) => queued !== channel,
      );
    }
    this.dataChannelClose(channel);
  }

  dataChannelClose(channel: RTCDataChannel) {
    if (!(["closing", "closed"] as DCState[]).includes(channel.readyState)) {
      channel.setReadyState("closing");

      if (
        this.sctp.associationState === SCTP_STATE.ESTABLISHED &&
        !this.unannounced.has(channel)
      ) {
        // Check if channel.id is already in reconfigQueue to prevent duplicates
        if (!this.sctp.reconfigQueue.includes(channel.id)) {
          this.sctp.reconfigQueue.push(channel.id);
        }
        if (this.sctp.reconfigQueue.length === 1) {
          this.sctp.transmitReconfigRequest();
        }
      } else {
        // By identity: an ID alone may be reused by another channel.
        this.dataChannelQueue = this.dataChannelQueue.filter(
          (queueItem) => queueItem[0] !== channel,
        );
        this.unannounced.delete(channel);
        // Remove any pending reconfiguration requests for this channel
        this.sctp.reconfigQueue = this.sctp.reconfigQueue.filter(
          (streamId) => streamId !== channel.id,
        );
        if (
          channel.id != undefined &&
          this.dataChannels[channel.id] === channel
        ) {
          delete this.dataChannels[channel.id];
        }
        channel.setReadyState("closed");
      }
    }
  }
}

export class RTCSctpCapabilities {
  public maxMessageSize: number;

  constructor(maxMessageSize: number) {
    this.maxMessageSize = maxMessageSize;
  }
}

class BridgeDtls implements Transport {
  private dtls: RTCDtlsTransport;

  constructor(dtls: RTCDtlsTransport) {
    this.dtls = dtls;
  }
  set onData(onData: (buf: Buffer) => void) {
    this.dtls.dataReceiver = onData;
  }
  readonly send = (data: Buffer) => {
    return this.dtls.sendData(data);
  };
  close() {}
}
