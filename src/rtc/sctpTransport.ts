import { RTCDataChannel } from "./dataChannel";
import {
  DATA_CHANNEL_RELIABLE,
  DATA_CHANNEL_OPEN,
  WEBRTC_DCEP,
  State
} from "./const";
import { Pack } from "jspack/jspack";

export class RTCSctpTransport {
  private dataChannels: { [key: string]: RTCDataChannel } = {};
  private dataChannelQueue: [RTCDataChannel, number, Buffer][] = [];
  get dataChannelKeys() {
    return Object.keys(this.dataChannels);
  }
  private associationState = State.CLOSED;

  constructor() {}

  dataChannelOpen(channel: RTCDataChannel) {
    if (channel.id) {
      if (this.dataChannelKeys.includes(channel.id.toString()))
        throw new Error(
          `Data channel with ID ${channel.id} already registered`
        );
      this.dataChannels[channel.id.toString()] = channel;
    }

    let channelType = DATA_CHANNEL_RELIABLE;
    let priority = 0;
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
    let data = Pack("!BBHLHH", [
      DATA_CHANNEL_OPEN,
      channelType,
      priority,
      reliability,
      channel.label.length,
      channel.protocol.length
    ]);
    data = Buffer.concat([
      data,
      Buffer.from(channel.label, "utf8"),
      Buffer.from(channel.protocol, "utf8")
    ]);
    this.dataChannelQueue.push([channel, WEBRTC_DCEP, data]);
    this.dataChannelFlush();
  }

  private async dataChannelFlush() {
    if (this.associationState != State.ESTABLISHED) return;
  }
}
