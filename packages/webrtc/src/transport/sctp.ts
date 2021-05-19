import debug from "debug";
import { jspack } from "jspack";
import { Event } from "rx.mini";
import * as uuid from "uuid";

import { SCTP, SCTP_STATE, Transport } from "../../../sctp/src";
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
  DCState,
  RTCDataChannel,
  RTCDataChannelParameters,
} from "../dataChannel";
import { RTCDtlsTransport } from "./dtls";

const log = debug("werift/webrtc/transport/sctp");

export class RTCSctpTransport {
  readonly onDataChannel = new Event<[RTCDataChannel]>();
  readonly uuid = uuid.v4();
  readonly sctp = new SCTP(new BridgeDtls(this.dtlsTransport), this.port);
  mid?: string;
  bundled = false;
  dataChannels: { [key: number]: RTCDataChannel } = {};

  private dataChannelQueue: [RTCDataChannel, number, Buffer][] = [];
  private dataChannelId?: number;

  constructor(public dtlsTransport: RTCDtlsTransport, public port = 5000) {
    this.sctp.onReceive.subscribe(this.datachannelReceive);
    this.sctp.onReconfigStreams.subscribe((ids: number[]) => {
      ids.forEach((id) => {
        const dc = this.dataChannels[id];
        if (!dc) return;
        // todo fix
        dc.setReadyState("closing");
        dc.setReadyState("closed");
        delete this.dataChannels[id];
      });
    });
    this.sctp.stateChanged.connected.subscribe(() => {
      Object.values(this.dataChannels).forEach((channel) => {
        if (channel.negotiated && channel.readyState !== "open") {
          channel.setReadyState("open");
        }
      });
      this.dataChannelFlush();
    });
    this.sctp.stateChanged.closed.subscribe(() => {
      Object.values(this.dataChannels).forEach((dc) => {
        dc.setReadyState("closed");
      });
      this.dataChannels = {};
    });
    this.sctp.onSackReceived = async () => {
      await this.dataChannelFlush();
    };

    this.dtlsTransport.onStateChange.subscribe((state) => {
      if (state === "closed") {
        this.sctp.setState(SCTP_STATE.CLOSED);
      }
    });
  }

  private get isServer() {
    return this.dtlsTransport.iceTransport.role !== "controlling";
  }

  channelByLabel(label: string) {
    return Object.values(this.dataChannels).find((d) => d.label === label);
  }

  private datachannelReceive = async (
    streamId: number,
    ppId: number,
    data: Buffer
  ) => {
    if (ppId === WEBRTC_DCEP && data.length > 0) {
      log("DCEP", streamId, ppId, data);
      switch (data[0]) {
        case DATA_CHANNEL_OPEN:
          {
            if (data.length >= 12) {
              if (Object.keys(this.dataChannels).includes(streamId.toString()))
                throw new Error();

              const [
                ,
                channelType,
                ,
                reliability,
                labelLength,
                protocolLength,
              ] = jspack.Unpack("!BBHLHH", data);

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

              this.dataChannelQueue.push([
                channel,
                WEBRTC_DCEP,
                Buffer.from(jspack.Pack("!B", [DATA_CHANNEL_ACK])),
              ]);

              this.onDataChannel.execute(channel);
              channel.setReadyState("open");

              await this.dataChannelFlush();
            }
          }
          break;
        case DATA_CHANNEL_ACK:
          log("DATA_CHANNEL_ACK");
          const channel = this.dataChannels[streamId];
          if (!channel) throw new Error();
          channel.setReadyState("open");
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
        channel.message.execute(msg);
        channel.emit("message", { data: msg });
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
    if (channel.id) {
      if (this.dataChannels[channel.id])
        throw new Error(
          `Data channel with ID ${channel.id} already registered`
        );
      this.dataChannels[channel.id] = channel;
    }

    let channelType = DATA_CHANNEL_RELIABLE;
    const priority = 0;
    let reliability = 0;

    if (!channel.ordered) {
      channelType = 0x80;
    }
    if (channel.maxRetransmits) {
      channelType = 1;
      reliability = channel.maxRetransmits;
    } else if (channel.maxPacketLifeTime) {
      channelType = 2;
      reliability = channel.maxPacketLifeTime;
    }

    // 5.1.  DATA_CHANNEL_OPEN Message
    const data = jspack.Pack("!BBHLHH", [
      DATA_CHANNEL_OPEN,
      channelType,
      priority,
      reliability,
      channel.label.length,
      channel.protocol.length,
    ]);
    const send = Buffer.concat([
      Buffer.from(data),
      Buffer.from(channel.label, "utf8"),
      Buffer.from(channel.protocol, "utf8"),
    ]);
    this.dataChannelQueue.push([channel, WEBRTC_DCEP, send]);
    this.dataChannelFlush();
  }

  private async dataChannelFlush() {
    // """
    // Try to flush buffered data to the SCTP layer.

    // We wait until the association is established, as we need to know
    // whether we are a client or a server to correctly assign an odd/even ID
    // to the data channels.
    // """

    if (this.sctp.associationState != SCTP_STATE.ESTABLISHED) return;
    if (this.sctp.outboundQueue.length > 0) return;

    while (this.dataChannelQueue.length > 0) {
      const [channel, protocol, userData] = this.dataChannelQueue.shift()!;

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
        await this.sctp.send(streamId, protocol, userData);
      } else {
        const expiry = channel.maxPacketLifeTime
          ? Date.now() + channel.maxPacketLifeTime / 1000
          : undefined;

        await this.sctp.send(
          streamId,
          protocol,
          userData,
          expiry,
          channel.maxRetransmits,
          channel.ordered
        );
        channel.addBufferedAmount(-userData.length);
      }
    }
  }

  datachannelSend = (channel: RTCDataChannel, data: Buffer | string) => {
    channel.addBufferedAmount(data.length);

    this.dataChannelQueue.push(
      typeof data === "string"
        ? [channel, WEBRTC_STRING, Buffer.from(data)]
        : [channel, WEBRTC_BINARY, data]
    );

    if (this.sctp.associationState !== SCTP_STATE.ESTABLISHED) {
      log("sctp not established", this.sctp.associationState);
    }

    this.dataChannelFlush();
  };

  static getCapabilities() {
    return new RTCSctpCapabilities(65536);
  }

  async start(remotePort: number) {
    if (this.isServer) {
      this.dataChannelId = 0;
    } else {
      this.dataChannelId = 1;
    }
    this.sctp.isServer = this.isServer;

    await this.sctp.start(remotePort);
  }

  async stop() {
    this.dtlsTransport.dataReceiver = () => {};
    await this.sctp.stop();
  }

  dataChannelClose(channel: RTCDataChannel) {
    if (!(["closing", "closed"] as DCState[]).includes(channel.readyState)) {
      channel.setReadyState("closing");

      if (this.sctp.associationState === SCTP_STATE.ESTABLISHED) {
        this.sctp.reconfigQueue.push(channel.id);
        if (this.sctp.reconfigQueue.length === 1) {
          this.sctp.transmitReconfigRequest();
        }
      } else {
        this.dataChannelQueue = this.dataChannelQueue.filter(
          (queueItem) => queueItem[0].id !== channel.id
        );
        if (channel.id) {
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
  readonly send = this.dtls.sendData;
  close() {}
}
