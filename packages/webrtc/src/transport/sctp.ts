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
  DATA_CHANNEL_RELIABLE,
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
import { debug, Event, FifoQueue } from "../imports/common";
import type { RTCDtlsTransport } from "./dtls";

const log = debug("werift:packages/webrtc/src/transport/sctp.ts");
export const DEFAULT_MAX_MESSAGE_SIZE = 65536;

export class RTCSctpTransport {
  dtlsTransport!: RTCDtlsTransport;
  sctp!: SCTP;

  readonly onDataChannel = new Event<[RTCDataChannel]>();
  readonly id = randomUUID().toString();

  mid?: string;
  mLineIndex?: number;
  bundled = false;
  dataChannels: { [key: number]: RTCDataChannel } = {};
  /** Set by stop(); nothing received afterwards reaches the application. */
  private stopped = false;
  remoteMaxMessageSize = DEFAULT_MAX_MESSAGE_SIZE;

  private dataChannelQueue = new FifoQueue<[RTCDataChannel, number, Buffer]>();
  private dataChannelId?: number;
  private eventDisposer: (() => void)[] = [];
  private stopping = false;
  /** Associations whose start began before DTLS peer authentication. */
  private readonly preAuthenticationStarts = new WeakSet<SCTP>();

  constructor(
    public port = 5000,
    public maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE,
    private readonly sctpOptions: SCTPOptions = {},
  ) {}

  get transport() {
    return this.dtlsTransport;
  }

  setDtlsTransport(dtlsTransport: RTCDtlsTransport) {
    if (this.dtlsTransport && this.dtlsTransport.id === dtlsTransport.id) {
      return;
    }

    this.disposeSctpListeners();

    this.dtlsTransport = dtlsTransport;
    this.stopping = false;
    this.stopped = false;
    this.createSctpAssociation();
  }

  private disposeSctpListeners() {
    this.eventDisposer.forEach((dispose) => dispose());
    this.eventDisposer = [];
  }

  private createSctpAssociation() {
    this.disposeSctpListeners();
    this.stopped = false;
    this.sctp = new SCTP(
      new BridgeDtls(this.dtlsTransport),
      this.port,
      this.sctpOptions,
    );
    const association = this.sctp;

    this.eventDisposer = [
      ...[
        association.onReceive.subscribe(this.datachannelReceive),
        association.onReconfigStreams.subscribe((ids: number[]) => {
          ids.forEach((id) => {
            const dc = this.dataChannels[id];
            if (!dc) return;
            // todo fix
            dc.setReadyState("closing");
            dc.setReadyState("closed");
            delete this.dataChannels[id];
          });
        }),
        association.stateChanged.connected.subscribe(() => {
          Object.values(this.dataChannels).forEach((channel) => {
            if (channel.negotiated && channel.readyState !== "open") {
              channel.setReadyState("open");
            }
          });
          this.dataChannelFlush();
        }),
        association.stateChanged.closed.subscribe(() => {
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
            // DTLS failure is terminal for this SCTP association.  Do not
            // preserve queued DCEP/data for a retry after authentication has
            // failed, and close every channel immediately.
            this.stopping = true;
            // Close queued pre-establishment channels before SCTP removes its
            // state listeners; otherwise their DCEP entries are lost without
            // a DataChannel close event.
            this.closeDataChannels();
            association.setState(SCTP_STATE.CLOSED);
            this.disposeSctpListeners();
          }
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

  private get isServer() {
    return this.dtlsTransport.role === "server";
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

            if (!Object.keys(this.dataChannels).includes(streamId.toString())) {
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

              this.onDataChannel.execute(channel);
              channel.setReadyState("open");
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
              throw new Error("channel not found");
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
              throw new Error();
          }
        })();

        // Update reception statistics
        channel.messagesReceived++;
        channel.bytesReceived += data.length;

        channel.onMessage.execute(msg);
        channel.emit("message", { data: msg });
        if (channel.onmessage) {
          channel.onmessage({ data: msg });
        }
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

    this.dataChannels[channel.id] = channel;

    if (this.sctp.associationState === SCTP_STATE.ESTABLISHED) {
      channel.setReadyState("open");
    }
  }

  dataChannelOpen(channel: RTCDataChannel) {
    if (channel.id !== undefined) {
      if (this.dataChannels[channel.id])
        throw new Error(
          `Data channel with ID ${channel.id} already registered`,
        );
      this.dataChannels[channel.id] = channel;
    }

    let channelType = DATA_CHANNEL_RELIABLE;
    const priority = 0;
    let reliability = 0;

    if (!channel.ordered) {
      channelType = 0x80;
    }
    if (channel.maxRetransmits !== null) {
      channelType = 1;
      reliability = channel.maxRetransmits;
    } else if (channel.maxPacketLifeTime !== null) {
      channelType = 2;
      reliability = channel.maxPacketLifeTime;
    }

    // 5.1.  DATA_CHANNEL_OPEN Message
    // !BBHLHH — message type / channel type / priority / reliability / label len / protocol len
    const data = Buffer.allocUnsafe(12);
    data.writeUInt8(DATA_CHANNEL_OPEN, 0);
    data.writeUInt8(channelType, 1);
    data.writeUInt16BE(priority, 2);
    data.writeUInt32BE(reliability, 4);
    data.writeUInt16BE(channel.label.length, 8);
    data.writeUInt16BE(channel.protocol.length, 10);
    const send = Buffer.concat([
      data,
      Buffer.from(channel.label, "utf8"),
      Buffer.from(channel.protocol, "utf8"),
    ]);
    this.dataChannelQueue.push([channel, WEBRTC_DCEP, send]);
    this.dataChannelFlush();
  }

  private dataChannelFlush() {
    // """
    // Try to flush buffered data to the SCTP layer.

    // We wait until the association is established, as we need to know
    // whether we are a client or a server to correctly assign an odd/even ID
    // to the data channels.
    // """

    if (this.sctp.associationState != SCTP_STATE.ESTABLISHED) return;
    // The peer's INIT can establish an association that joined a connected
    // DTLS transport before start() ran here; the same side decides the IDs.
    this.dataChannelId ??= this.isServer ? 0 : 1;

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

      let streamId = channel.id;
      if (streamId === undefined) {
        streamId = this.dataChannelId!;
        while (Object.keys(this.dataChannels).includes(streamId.toString())) {
          streamId += 2;
        }
        this.dataChannels[streamId] = channel;
        channel.setId(streamId);
      }

      if (protocol === WEBRTC_DCEP) {
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
            ? Date.now() + channel.maxPacketLifeTime / 1000
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
  }

  /** Close retained channels even when SCTP removed its state listeners. */
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
    this.dataChannels = {};

    for (const channel of channels) {
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
    if (this.isServer) {
      this.dataChannelId = 1;
    } else {
      this.dataChannelId = 0;
    }
    // SCTP's `isServer` flag means passive COOKIE-WAIT peer. WARP assigns the
    // active INIT sender to the DTLS server, independently of the ICE role.
    this.sctp.isServer = !this.isServer;

    await this.sctp.start(remotePort);
  }

  async stop() {
    this.stopping = true;
    this.stopped = true;
    this.dtlsTransport.dataReceiver = () => {};
    // User data is owned by the stopped association; preserve only DCEP OPEN
    // entries so a later association can discard them if the channel closed.
    this.discardUnsentMessages();
    const retainedOpens = this.dataChannelQueue.toArray();
    // SCTP removes its own state listeners when it reaches CLOSED, so close
    // the channels registered on this association here. Channels whose OPEN
    // is still queued outlive the transport (rollback re-announces them);
    // PeerConnection shutdown closes those in SctpTransportManager.close().
    this.closeDataChannels({ clearQueue: false, includeQueued: false });
    try {
      await this.sctp.stop();
    } finally {
      // SCTP's CLOSED listener also clears its queue; restore retained OPENs
      // afterward so a later association can discard them deterministically.
      this.dataChannelQueue = new FifoQueue(retainedOpens);
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
  }

  dataChannelClose(channel: RTCDataChannel) {
    if (!(["closing", "closed"] as DCState[]).includes(channel.readyState)) {
      channel.setReadyState("closing");

      if (this.sctp.associationState === SCTP_STATE.ESTABLISHED) {
        // Check if channel.id is already in reconfigQueue to prevent duplicates
        if (!this.sctp.reconfigQueue.includes(channel.id)) {
          this.sctp.reconfigQueue.push(channel.id);
        }
        if (this.sctp.reconfigQueue.length === 1) {
          this.sctp.transmitReconfigRequest();
        }
      } else {
        this.dataChannelQueue = this.dataChannelQueue.filter(
          (queueItem) => queueItem[0].id !== channel.id,
        );
        // Remove any pending reconfiguration requests for this channel
        this.sctp.reconfigQueue = this.sctp.reconfigQueue.filter(
          (streamId) => streamId !== channel.id,
        );
        if (channel.id !== undefined) {
          delete this.dataChannels[channel.id];
        }
        channel.setReadyState("closed");
      }
    }
  }
}

export class RTCSctpCapabilities {
  constructor(public maxMessageSize: number) {}
}

class BridgeDtls implements Transport {
  constructor(private dtls: RTCDtlsTransport) {}
  set onData(onData: (buf: Buffer) => void) {
    this.dtls.dataReceiver = onData;
  }
  readonly send = (data: Buffer) => {
    return this.dtls.sendData(data);
  };
  close() {}
}
