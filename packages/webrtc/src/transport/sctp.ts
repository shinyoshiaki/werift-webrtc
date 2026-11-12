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
import { EventTarget as DomEventTarget, notifySafely } from "../helper";
import { debug, Event, FifoQueue } from "../imports/common";
import type { RTCDtlsTransport } from "./dtls";

const log = debug("werift:packages/webrtc/src/transport/sctp.ts");
export const DEFAULT_MAX_MESSAGE_SIZE = 65536;

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
  private dataChannelId?: number;
  private eventDisposer: (() => void)[] = [];

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
    notifySafely(log, "onStateChange", () => this.onStateChange.execute(state));
    if (emitEvent) {
      notifySafely(log, "onstatechange", () => this.onstatechange?.());
      notifySafely(log, "statechange", () => this.events.emit("statechange"));
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
   * Channels still waiting for a stream ID stay queued for the next
   * association.
   */
  async resetAssociation(dtlsTransport = this.dtlsTransport) {
    await this.stop();
    this.dataChannelQueue = this.dataChannelQueue.filter(
      ([channel]) => channel.id === undefined,
    );
    this.dataChannelId = undefined;
    this.bindAssociation(dtlsTransport);
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

  private bindAssociation(dtlsTransport: RTCDtlsTransport) {
    this.eventDisposer.forEach((dispose) => dispose());

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
        this.sctp.onReconfigStreams.subscribe((ids: number[]) => {
          ids.forEach((id) => {
            const dc = this.dataChannels[id];
            if (!dc) return;
            // todo fix
            dc.setReadyState("closing");
            dc.setReadyState("closed");
            delete this.dataChannels[id];
          });
        }),
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
          Object.values(this.dataChannels).forEach((dc) => {
            dc.setReadyState("closed");
          });
          this.dataChannels = {};
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
      ].map((e) => e.unSubscribe),
      () => (this.sctp.onSackReceived = async () => {}),
    ];

    this.sctp.onSackReceived = async () => {
      this.dataChannelFlush();
    };
  }

  private get isServer() {
    const role =
      this.dtlsTransport.iceRoleAtStart ?? this.dtlsTransport.iceTransport.role;
    return role !== "controlling";
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
    // Label / Protocol Length are byte counts of the UTF-8 fields (RFC 8832
    // 5.1), so they come from the encoded buffers, not from string.length.
    // Their 16-bit limit is enforced by the RTCDataChannel constructor.
    const label = Buffer.from(channel.label, "utf8");
    const protocol = Buffer.from(channel.protocol, "utf8");

    if (channel.id !== undefined) {
      if (this.dataChannels[channel.id])
        throw new Error(
          `Data channel with ID ${channel.id} already registered`,
        );
      this.dataChannels[channel.id] = channel;
    }

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
        // An association the remote established before start() decides the
        // parity here (RFC 8832: DTLS client even; ICE controlling is server).
        this.dataChannelId ??= this.isServer ? 0 : 1;
        streamId = this.dataChannelId;
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
    this.dataChannelId = this.isServer ? 0 : 1;
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
