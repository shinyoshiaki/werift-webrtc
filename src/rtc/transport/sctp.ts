import { RTCDataChannel, RTCDataChannelParameters } from "../dataChannel";
import {
  DATA_CHANNEL_RELIABLE,
  DATA_CHANNEL_OPEN,
  WEBRTC_DCEP,
  DATA_CHANNEL_ACK,
  WEBRTC_STRING,
  WEBRTC_STRING_EMPTY,
  WEBRTC_BINARY,
  WEBRTC_BINARY_EMPTY,
} from "../const";
import { jspack } from "jspack";
import { RTCDtlsTransport, DtlsState } from "./dtls";
import { Event } from "rx.mini";
import { SCTP, SCTP_STATE, Transport } from "../../vendor/sctp";
import * as uuid from "uuid";

export class RTCSctpTransport {
  datachannel = new Event<RTCDataChannel>();
  uuid = uuid.v4();
  mid?: string;
  bundled = false;

  private dataChannels: { [key: number]: RTCDataChannel } = {};
  get dataChannelsKeys() {
    return Object.keys(this.dataChannels);
  }
  private dataChannelQueue: [RTCDataChannel, number, Buffer][] = [];

  private dataChannelId?: number;

  sctp: SCTP;

  constructor(public dtlsTransport: RTCDtlsTransport, public port = 5000) {
    const bridge = new Bridge(dtlsTransport);
    this.sctp = new SCTP(bridge, port);

    this.sctp.onReceive = (streamId, ppId, data) => {
      this.datachannelReceive(streamId, ppId, data);
    };
    this.sctp.onDeleteStreams = (ids: number[]) => {
      ids.forEach((id) => {
        const dc = this.dataChannels[id];
        if (dc) {
          dc.setReadyState("closed");
          delete this.dataChannels[id];
        }
      });
    };

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
    this.dtlsTransport.stateChanged.subscribe((state) => {
      if (state === DtlsState.CLOSED) {
        this.sctp.setState(SCTP_STATE.CLOSED);
      }
    });
  }

  private get isServer() {
    return this.dtlsTransport.iceTransport.role !== "controlling";
  }

  private async datachannelReceive(
    streamId: number,
    ppId: number,
    data: Buffer
  ) {
    if (ppId === WEBRTC_DCEP && data.length > 0) {
      switch (data[0]) {
        case DATA_CHANNEL_OPEN:
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

            let maxPacketLifeTime;
            let maxRetransmits;
            if ((channelType & 0x03) === 1) {
              maxRetransmits = reliability;
            } else if ((channelType & 0x03) === 2) {
              maxPacketLifeTime = reliability;
            }

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
            channel.setReadyState("open");
            this.dataChannels[streamId] = channel;

            this.dataChannelQueue.push([
              channel,
              WEBRTC_DCEP,
              Buffer.from(jspack.Pack("!B", [DATA_CHANNEL_ACK])),
            ]);
            this.dataChannelFlush();

            this.datachannel.execute(channel);
          }
          break;
        case DATA_CHANNEL_ACK:
          const channel = this.dataChannels[streamId];
          if (!channel) throw new Error();
          channel.setReadyState("open");
          break;
      }
    } else {
      const channel = this.dataChannels[streamId];
      if (channel) {
        switch (ppId) {
          case WEBRTC_STRING:
            channel.message.execute(data.toString("utf8"));
            break;
          case WEBRTC_STRING_EMPTY:
            channel.message.execute("");
            break;
          case WEBRTC_BINARY:
            channel.message.execute(data);
            break;
          case WEBRTC_BINARY_EMPTY:
            channel.message.execute(Buffer.from(""));
            break;
        }
      }
    }
  }

  dataChannelAddNegotiated(channel: RTCDataChannel) {
    if (!channel.id) throw new Error();
    if (this.dataChannelsKeys.includes(channel.id.toString()))
      throw new Error();

    this.dataChannels[channel.id] = channel;

    if (this.sctp.associationState === SCTP_STATE.ESTABLISHED) {
      channel.setReadyState("open");
    }
  }

  dataChannelOpen(channel: RTCDataChannel) {
    if (channel.id) {
      if (this.dataChannelsKeys.includes(channel.id.toString()))
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

  private dataChannelFlush() {
    // """
    // Try to flush buffered data to the SCTP layer.

    // We wait until the association is established, as we need to know
    // whether we are a client or a server to correctly assign an odd/even ID
    // to the data channels.
    // """

    if (this.sctp.associationState != SCTP_STATE.ESTABLISHED) return;

    let expiry: number | undefined;
    while (
      this.dataChannelQueue.length > 0 &&
      this.sctp.outboundQueue.length === 0
    ) {
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
        this.sctp.send(streamId, protocol, userData);
      } else {
        if (channel.maxPacketLifeTime) {
          expiry = Date.now() + channel.maxPacketLifeTime / 1000;
        } else {
          expiry = undefined;
        }
        this.sctp.send(
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

  datachannelSend(channel: RTCDataChannel, data: Buffer) {
    channel.addBufferedAmount(data.length);
    this.dataChannelQueue.push([channel, WEBRTC_BINARY, data]);
    if (this.sctp.associationState !== SCTP_STATE.ESTABLISHED) {
      console.warn("sctp not established", this.sctp.associationState);
    }
    this.dataChannelFlush();
  }

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

    this.sctp.start(remotePort);
  }

  stop() {
    this.dtlsTransport.dataReceiver = undefined;
    this.sctp.stop();
  }

  dataChannelClose(channel: RTCDataChannel) {
    if (!["closing", "closed"].includes(channel.readyState)) {
      channel.setReadyState("closing");

      if (this.sctp.associationState === SCTP_STATE.ESTABLISHED) {
        this.sctp.reconfigQueue.push(channel.id);
        if (this.sctp.reconfigQueue.length === 1) {
          this.sctp.transmitReconfig();
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
      // this.sctp.sendResetRequest(channel.id);
    }
  }
}

export class RTCSctpCapabilities {
  constructor(public maxMessageSize: number) {}
}

class Bridge implements Transport {
  constructor(private transport: RTCDtlsTransport) {}
  set onData(onData: (buf: Buffer) => void) {
    this.transport.dataReceiver = onData;
  }
  send(data: Buffer) {
    this.transport.sendData(data);
  }
  close() {}
}
