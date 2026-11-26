import { randomUUID } from "crypto";
import {
  SCTP,
  SCTP_STATE,
  type SCTPOptions,
  type Transport,
} from "../../../sctp/src";
import { SCTPStartCancelledError } from "../../../sctp/src/sctp";
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
/**
 * How long the DTLS client (passive SCTP side) waits for the peer's INIT
 * after DTLS authentication before sending INIT itself. A peer that picks
 * the SCTP initiator by the ICE role (older werift) may wait as well; well
 * below the SCTP initial RTO (3 s), so a lost INIT also recovers sooner.
 */
export const PASSIVE_INIT_FALLBACK_MS = 1000;

/**
 * Stream IDs a data channel may use: 0..65534 (W3C webrtc-pc, RFC 8831 section 6.5).
 * @see tests/issue/815.test.ts "a reservation beyond the negotiated stream limit is given back and fails"
 */
const DATA_CHANNEL_ID_LIMIT = 65535;

/**
 * Which direction of a closing channel's stream is reset (RFC 8831 6.7).
 * @see tests/issue/815.reset.test.ts "close fires on neither end before both directions of the stream are reset"
 */
interface ClosingStream {
  outgoing: boolean;
  incoming: boolean;
  /** Test: tests/issue/815.reset.test.ts "a legacy peer that does not reset its side (ordered=%s, no data from it): close fires after reverseResetTimeout and the ID stays in use" */
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
   * In-band channels created here whose DATA_CHANNEL_OPEN is not sent yet;
   * their stream ID, if any, is a reservation.
   * @see tests/issue/815.test.ts "a rollback gives back the IDs a pranswer reserved"
   * @see tests/issue/815.test.ts "a move to a DTLS transport with a decided role assigns its parity; a reset association waits for the next negotiation"
   */
  private readonly unannounced = new Set<RTCDataChannel>();
  private eventDisposer: (() => void)[] = [];
  private stopping = false;
  /** Associations whose start began before DTLS peer authentication. */
  private readonly preAuthenticationStarts = new WeakSet<SCTP>();
  /**
   * Closing channels' streams and which reset direction is done.
   * @see tests/issue/815.reset.test.ts "close fires on neither end before both directions of the stream are reset"
   */
  private readonly closingStreams = new Map<number, ClosingStream>();
  /**
   * @internal
   * How long a channel waits for the peer to reset its side. 5 s covers one
   * retransmission of a lost reset request (SCTP RTO.Initial 3 s, RFC 9260
   * section 16).
   * @see tests/issue/815.reset.test.ts "a legacy peer that does not reset its side (ordered=%s, no data from it): close fires after reverseResetTimeout and the ID stays in use"
   */
  reverseResetTimeout = 5_000;
  /**
   * Streams closed by {@link RTCSctpTransport.reverseResetTimeout}: in use
   * until the peer's reset arrives or the association ends.
   * @see tests/issue/815.reset.test.ts "a peer reset arriving after reverseResetTimeout closes nothing and frees the ID"
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
   * Channels whose DATA_CHANNEL_OPEN was not sent stay, without stream ID.
   * @see tests/issue/815.test.ts "a move to a DTLS transport with a decided role assigns its parity; a reset association waits for the next negotiation"
   */
  async resetAssociation(dtlsTransport = this.dtlsTransport) {
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
   * `assignIds`: unannounced channels take stream IDs from the bound DTLS
   * transport's role at once.
   * @see tests/issue/815.test.ts "a move to a DTLS transport with a decided role assigns its parity; a reset association waits for the next negotiation"
   */
  private bindAssociation(
    dtlsTransport: RTCDtlsTransport,
    { assignIds = true }: { assignIds?: boolean } = {},
  ) {
    this.disposeSctpListeners();
    this.dtlsTransport = dtlsTransport;
    this.stopping = false;
    this.stopped = false;
    this.createSctpAssociation();
    if (assignIds) {
      this.releaseUnannouncedStreamIds();
      this.assignPendingStreamIds();
    }
  }

  private disposeSctpListeners() {
    this.eventDisposer.forEach((dispose) => dispose());
    this.eventDisposer = [];
  }

  private createSctpAssociation() {
    this.disposeSctpListeners();
    this.clearClosingStreams();
    this.stopped = false;
    this.setState("connecting", false);
    this.sctp = new SCTP(
      new BridgeDtls(this.dtlsTransport),
      this.port,
      this.sctpOptions,
    );
    const association = this.sctp;

    this.eventDisposer = [
      ...[
        association.onReceive.subscribe(this.datachannelReceive),
        association.onReconfigStreams.subscribe((ids, direction) =>
          this.onStreamsReset(ids, direction),
        ),
        association.stateChanged.connected.subscribe(() => {
          this.setState("connected");
          Object.values(this.dataChannels).forEach((channel) => {
            if (channel.negotiated && channel.readyState !== "open") {
              channel.setReadyState("open");
            }
          });
          this.dataChannelFlush();
        }),
        association.stateChanged.closed.subscribe(() => {
          if (!this.stopped) this.setState("closed");
          this.clearClosingStreams();
          // An explicit stop() closes the channels registered on this
          // association only; channels whose OPEN is still queued outlive it
          // (rollback re-announces them on the next association).
          if (this.stopping) {
            this.closeDataChannels({ clearQueue: false, includeQueued: false });
            return;
          }
          // Keep pre-establishment channels and queued DCEP available for a
          // retry. Once an association was established, closing it closes them.
          if (!association.hadEstablished) return;
          this.closeDataChannels();
        }),
        ...(() => {
          // A pre-established early association cannot make progress after
          // permission is revoked. Cancel it immediately instead of waiting
          // for SCTP T1 retransmissions to expire; authenticated retry will
          // create a fresh association through SctpTransportManager.
          // SCTP refuses once COOKIE_ECHO / COOKIE_ACK was handed off (the
          // peer may be ESTABLISHED and never re-INIT). Such a start is kept;
          // a cancelled attempt may have dropped the peer's in-flight reply,
          // so retransmit now rather than at the next T1 expiry.
          //
          // The cancel applies only to the early attempt itself:
          // - a start made after DTLS peer authentication is not early, and
          //   an early start becomes ordinary once DTLS authenticates; both
          //   must survive SPED resets / ICE restarts;
          // - only the DTLS server (the active INIT sender) sends SCTP under
          //   the early permission. The DTLS client's passive association
          //   is merely armed early; cancelling it would discard the cookie
          //   key of an INIT_ACK it already sent, so the peer's COOKIE_ECHO
          //   could never be accepted.
          const cancelEarlyStart = () => {
            if (this.sctp !== association) return;
            const earlyAttempt =
              this.preAuthenticationStarts.has(association) &&
              this.dtlsTransport.role === "server" &&
              // An early start still pending once DTLS authenticated no
              // longer depends on the early permission: its retransmissions
              // are ordinary authenticated sends.
              this.dtlsTransport.state !== "connected";
            if (
              earlyAttempt &&
              association.cancelStart(new SCTPStartCancelledError())
            ) {
              return;
            }
            // The start is kept (not early, or already committed). The reset
            // may have dropped an in-flight reply, so retransmit the pending
            // INIT / COOKIE_ECHO now instead of at the next T1 expiry
            // (no-op when nothing is pending, e.g. the passive side).
            association.retransmitStartNow();
          };
          return [
            this.dtlsTransport.onEarlyApplicationSendRevoked?.subscribe(
              cancelEarlyStart,
            ),
            this.dtlsTransport.onEarlyApplicationAttemptCancelled?.subscribe(
              cancelEarlyStart,
            ),
          ].flatMap((subscription) => (subscription ? [subscription] : []));
        })(),
        this.dtlsTransport.onStateChange.subscribe((state) => {
          if (state === "connected") {
            // A start kept across a cancel/revoke can proceed now; don't wait
            // for the next T1 expiry.
            if (this.sctp === association) association.retransmitStartNow();
            return;
          }
          if (state === "failed" || state === "closed") {
            // A stopped transport is left to stop():
            // RTCPeerConnection.close() marks DTLS closed synchronously,
            // before stop() sends the SCTP ABORT, and closing the association
            // here would skip that ABORT.
            if (this.stopped) return;
            // DTLS failure is terminal for this SCTP association.  Do not
            // preserve queued DCEP/data for a retry after authentication has
            // failed, and close every channel immediately.
            this.stopping = true;
            // The channels' close notification sees the transport closed.
            this.setState("closed");
            // Close queued pre-establishment channels before SCTP removes its
            // state listeners; otherwise their DCEP entries are lost without
            // a DataChannel close event.
            this.closeDataChannels();
            association.setState(SCTP_STATE.CLOSED);
            this.disposeSctpListeners();
          }
        }),
        // Test: tests/issue/815.test.ts "issue 815: data channel stream IDs follow the DTLS role"
        // Test: tests/issue/815.test.ts "the DTLS start resolving auto assigns the IDs of the role it took"
        this.dtlsTransport.onRoleChange.subscribe(() => {
          this.releaseUnannouncedStreamIds();
          this.assignPendingStreamIds();
        }),
      ].map((e) => e.unSubscribe),
      () => (association.onSackReceived = async () => {}),
    ];

    association.onSackReceived = async () => {
      await this.dataChannelFlush();
    };
  }

  /** @internal Prepare a fresh association after INIT/T1 failure. */
  prepareForStart() {
    if (this.stopping) {
      throw new Error("SCTP transport is stopped");
    }
    if (this.sctp.state === "closed") {
      this.createSctpAssociation();
    }
    return this.sctp;
  }

  /**
   * RFC 8831 section 6.7: the first reset of a stream makes its channel
   * `closing`; it is `closed`, its ID released just before, once both
   * directions are reset.
   * @see tests/issue/815.reset.test.ts "issue 815: a stream ID reused after a close (RFC 8831 section 6.7 reset in both directions)"
   * @see tests/issue/815.notification.test.ts "closed by $closedBy: a close listener re-creates a channel on the only free ID"
   */
  private onStreamsReset(ids: number[], direction: "outgoing" | "incoming") {
    for (const id of ids) {
      if (direction === "incoming" && this.awaitingPeerReset.delete(id)) {
        // Test: tests/issue/815.reset.test.ts "a peer reset arriving after reverseResetTimeout closes nothing and frees the ID"
        this.sctp.reconfigQueue = this.sctp.reconfigQueue.filter(
          (streamId) => streamId !== id,
        );
        continue;
      }
      // Test: tests/issue/815.test.ts "issue 815: a DATA_CHANNEL_OPEN violating the odd/even rule on an unused stream"
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
        // Test: tests/issue/815.notification.test.ts "a closing listener closing the PeerConnection ends the channel once"
        if (this.dataChannels[id] !== dc || dc.readyState === "closed") {
          continue;
        }
      }
      if (direction === "incoming") this.answerIncomingReset(id, reset);
      this.completeClose(id, dc, reset);
    }
  }

  /**
   * Reset our side of a stream the peer reset, exactly once.
   * @see tests/issue/815.reset.test.ts "issue 815: a stream ID reused after a close (RFC 8831 section 6.7 reset in both directions)"
   */
  private answerIncomingReset(id: number, reset: ClosingStream) {
    const inFlight = !!this.sctp.reconfigRequest?.streams.includes(id);
    if (reset.outgoing || inFlight) {
      // Test: tests/issue/815.notification.test.ts "closed by both ends at once: a close listener re-creates a channel that opens"
      this.sctp.reconfigQueue = this.sctp.reconfigQueue.filter(
        (streamId) => streamId !== id,
      );
      return;
    }
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
        // Test: tests/issue/815.reset.test.ts "a peer reset arriving after reverseResetTimeout closes nothing and frees the ID"
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
    // Test: tests/issue/815.reset.test.ts "pc.close() while waiting for the peer's reset closes the channel once and leaves no timer"
    this.awaitingPeerReset.clear();
  }

  /**
   * The SCTP INIT side: the DTLS server, not the ICE role.
   * @see tests/issue/815.test.ts "#815 report: reversed ICE / DTLS roles with channels from both ends do not collide"
   */
  private get isServer() {
    return this.dtlsTransport.role === "server";
  }

  /**
   * RFC 8832 section 6: DTLS client even, server odd; none while `auto`.
   * @see tests/issue/815.test.ts "issue 815: data channel stream IDs follow the DTLS role"
   */
  /**
   * werift up to 0.27 picks its stream ID parity by the ICE role (controlling
   * odd), not by the DTLS role. With the ICE and DTLS roles reversed, such a
   * peer opens its channels on this side's parity, so an OPEN on an unused
   * stream of this parity is accepted instead of reset. An RFC 8832 peer never
   * uses this parity, so this changes nothing for it.
   * @see tests/integrate/legacySctpRole.test.ts "$name: 旧 werift が開いた DataChannel を受け入れ、label どおりに届く"
   */
  private get peerMayUseIceRoleParity() {
    const parity = this.idParity;
    if (parity === undefined) return false;
    const iceRole =
      this.dtlsTransport.iceRoleAtStart ?? this.dtlsTransport.iceTransport.role;
    return (parity === 1) !== (iceRole === "controlling");
  }

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

  /**
   * Exclusive upper bound of a stream ID: 65535, or what SCTP negotiated.
   * @see tests/issue/815.test.ts "a reservation beyond the negotiated stream limit is given back and fails"
   */
  private get streamIdLimit() {
    const negotiated = this.sctp?.maxChannels;
    return negotiated === undefined
      ? DATA_CHANNEL_ID_LIMIT
      : Math.min(negotiated, DATA_CHANNEL_ID_LIMIT);
  }

  /**
   * The lowest free stream ID of `parity`.
   * @see tests/issue/815.test.ts "auto IDs skip negotiated channels of either parity and reuse closed IDs"
   */
  private allocateStreamId(parity: 0 | 1) {
    const limit = this.streamIdLimit;
    const free = (id: number) =>
      !this.dataChannels[id] && !this.awaitingPeerReset.has(id);
    for (let id = parity; id < limit; id += 2) {
      if (free(id)) return id;
    }
    return undefined;
  }

  /**
   * @internal
   * Reserve a stream ID for every unannounced channel without one, from the
   * DTLS role; none left is an `OperationError` (W3C 4.4.1.6 step 2.2.6).
   * @see tests/issue/815.test.ts "a channel waiting for an ID closes with OperationError when none is left"
   */
  assignPendingStreamIds() {
    const parity = this.idParity;
    if (parity === undefined) return;
    const limit = this.streamIdLimit;
    for (const channel of [...this.unannounced]) {
      // Test: tests/issue/815.test.ts "a channel closed by an error handler is not given an ID"
      if (
        !this.unannounced.has(channel) ||
        channel.readyState === "closed" ||
        channel.readyState === "closing"
      ) {
        continue;
      }
      if (channel.id != undefined) {
        // Test: tests/issue/815.test.ts "a reservation beyond the negotiated stream limit is given back and fails"
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
   * Give back the reservations of unannounced channels.
   * @see tests/issue/815.test.ts "a %s gives the IDs back and the next answer, keeping the DTLS role, assigns them again"
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
              // Test: tests/issue/815.test.ts "is not acknowledged and the stream is reset, so neither channel stays connecting"
              log("DATA_CHANNEL_OPEN on a stream ID in local use, rejected", {
                streamId,
                label: existing.label,
              });
              this.rejectOpenOnStreamInUse(existing);
              return;
            }
            if (
              !existing &&
              streamId % 2 === this.idParity &&
              !this.peerMayUseIceRoleParity
            ) {
              // Test: tests/issue/815.test.ts "issue 815: a DATA_CHANNEL_OPEN violating the odd/even rule on an unused stream"
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

              // Test: tests/issue/815.notification.test.ts "datachannel: later listeners run and the channel opens on both ends"
              this.onDataChannel.executeIsolated(
                (error) => log("onDataChannel listener failed", error),
                channel,
              );
              channel.setReadyState("open");
            } else if (existing.readyState !== "open") {
              // Test: tests/issue/815.reset.test.ts "a DATA_CHANNEL_OPEN on the stream of a closing remote channel is not acknowledged"
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
              // Test: tests/issue/815.notification.test.ts "the receive callback ignores an ACK of an unknown stream and an unknown PPID"
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
        // Test: tests/issue/815.notification.test.ts "the receive callback ignores an ACK of an unknown stream and an unknown PPID"
        if (msg === undefined) {
          log("message with an unknown PPID, ignored", { streamId, ppId });
          return;
        }

        // W3C webrtc-pc "Receiving messages on a data channel" step 3.
        // Test: tests/issue/815.reset.test.ts "a message arriving while closing is discarded (W3C: not open discards it)"
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

        // Test: tests/issue/815.notification.test.ts "message: later listeners and later messages are delivered"
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
      // Test: tests/issue/815.reset.test.ts "a legacy peer that does not reset its side (ordered=%s, no data from it): close fires after reverseResetTimeout and the ID stays in use"
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

    // Test: tests/issue/815.test.ts "an in-band channel reaching the transport with an id is an internal error"
    if (channel.id != undefined) {
      throw new Error(
        "internal: an in-band data channel gets its stream ID from the DTLS role",
      );
    }
    // Test: tests/issue/815.test.ts "a channel waiting for an ID closes with OperationError when none is left"
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
   * established; a channel still without stream ID stays queued.
   * @see tests/issue/815.test.ts "issue 815: data channel stream IDs follow the DTLS role"
   */
  private dataChannelFlush() {
    if (this.sctp.associationState != SCTP_STATE.ESTABLISHED) return;
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

  /**
   * Close retained channels even when SCTP removed its state listeners.
   * @see tests/issue/815.test.ts "a throwing close listener of a registered channel skips no listener, channel or teardown"
   * @see tests/issue/815.notification.test.ts "association closed by the peer: a channel created in a close callback stays registered until pc.close()"
   * @see tests/issue/815.test.ts "pc.close() notifies close of a reserved, unannounced channel after the transports closed"
   */
  private closeDataChannels({
    clearQueue = true,
    includeQueued = true,
  }: {
    clearQueue?: boolean;
    includeQueued?: boolean;
  } = {}) {
    const channels = new Set<RTCDataChannel>([
      ...Object.values(this.dataChannels),
      ...(includeQueued
        ? this.dataChannelQueue.toArray().map(([channel]) => channel)
        : []),
    ]);
    if (clearQueue) this.dataChannelQueue.clear();
    else
      this.dataChannelQueue = this.dataChannelQueue.filter(
        ([queued]) => !channels.has(queued),
      );
    this.dataChannels = {};

    for (const channel of channels) {
      this.unannounced.delete(channel);
      if (channel.readyState === "closed") continue;
      try {
        channel.setReadyState("closed");
      } catch (error) {
        log("datachannel close callback failed", error);
      }
    }
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
    this.prepareForStart();
    // RTCDtlsTransport.state is "connected" only after SDP fingerprint
    // authentication, so anything earlier is an early (pre-auth) start.
    if (this.dtlsTransport.state !== "connected") {
      this.preAuthenticationStarts.add(this.sctp);
    }
    // SCTP's `isServer` flag means passive COOKIE-WAIT peer. WARP assigns the
    // active INIT sender to the DTLS server, independently of the ICE role.
    this.sctp.isServer = !this.isServer;
    if (!this.isServer) {
      this.schedulePassiveInitFallback(this.sctp);
    }

    await this.sctp.start(remotePort);
  }

  /**
   * DTLS client: if the peer's INIT has not arrived
   * {@link PASSIVE_INIT_FALLBACK_MS} after DTLS authentication, send INIT
   * ourselves (SCTP answers a colliding INIT, RFC 9260 §5.2.1). Never before
   * authentication: the DTLS client has no early send permission.
   */
  private schedulePassiveInitFallback(association: SCTP) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) return;
      timer = setTimeout(() => {
        if (this.sctp !== association || this.stopping) return;
        association.startPassiveFallbackInit().catch((error: Error) => {
          log("passive fallback INIT failed", error.message);
        });
      }, PASSIVE_INIT_FALLBACK_MS);
    };
    if (this.dtlsTransport.state === "connected") {
      arm();
    } else {
      const subscription = this.dtlsTransport.onStateChange.subscribe(
        (state) => {
          if (state !== "connected") return;
          subscription.unSubscribe();
          arm();
        },
      );
      this.eventDisposer.push(subscription.unSubscribe);
    }
    // The association is replaced or the transport stops: drop the timer.
    this.eventDisposer.push(() => clearTimeout(timer));
  }

  /** @internal Start once; an established or already started association stays intact. */
  async ensureStarted(remotePort: number) {
    if (
      this.sctp.started ||
      this.sctp.state === "connected" ||
      this.sctp.state === "closed"
    ) {
      return;
    }
    await this.start(remotePort);
  }

  /**
   * @internal
   * The synchronous part of {@link RTCSctpTransport.stop}: `closed` without
   * statechange, and nothing received afterwards reaches the application.
   * `RTCPeerConnection.close()` calls it before its first await.
   */
  markStopped() {
    this.stopping = true;
    this.stopped = true;
    this.setState("closed", false);
  }

  /**
   * @internal
   * `RTCPeerConnection.close()`, after stop(): close the channels whose
   * DATA_CHANNEL_OPEN was not sent (stop() keeps them for a rollback).
   * @see tests/issue/815.test.ts "pc.close() notifies close of a channel without an ID after SCTP / DTLS / the PeerConnection closed"
   * @see tests/issue/815.test.ts "pc.close() notifies close of a reserved, unannounced channel after the transports closed"
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
      // Test: tests/issue/815.test.ts "pc.close() closes every pending channel even if a close listener throws"
      channel.setReadyState("closed");
    }
  }

  async stop() {
    const closedAlready = this.sctp.state === "closed";
    this.markStopped();
    this.dtlsTransport.dataReceiver = () => {};
    this.discardUnsentMessages();
    try {
      await this.sctp.stop();
    } finally {
      // An association already CLOSED emits no closed event again.
      if (closedAlready) {
        this.closeDataChannels({ clearQueue: false, includeQueued: false });
      }
      this.disposeSctpListeners();
    }
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
   * Reset our outgoing stream (RFC 8831 section 6.7), which closes the
   * peer's channel on it.
   * @see tests/issue/815.test.ts "issue 815: a DATA_CHANNEL_OPEN violating the odd/even rule on an unused stream"
   */
  private resetStream(streamId: number) {
    if (!this.sctp.reconfigQueue.includes(streamId)) {
      this.sctp.reconfigQueue.push(streamId);
    }
    if (this.sctp.reconfigQueue.length === 1) {
      this.sctp.transmitReconfigRequest();
    }
  }

  /**
   * RFC 8832 section 6: an OPEN on a stream in use is not acknowledged and
   * the stream's channel closes (both ends claimed it).
   * @see tests/issue/815.test.ts "is not acknowledged and the stream is reset, so neither channel stays connecting"
   */
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
        // Test: tests/issue/815.test.ts "closing one channel before negotiation keeps the OPEN of another (queue filtered by identity)"
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
