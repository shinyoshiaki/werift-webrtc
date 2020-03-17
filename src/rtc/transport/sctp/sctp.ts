import { RTCDataChannel } from "../../dataChannel";
import {
  DATA_CHANNEL_RELIABLE,
  DATA_CHANNEL_OPEN,
  WEBRTC_DCEP,
  State
} from "../../const";
import { jspack } from "jspack";
import { RTCDtlsTransport } from "../dtls";
import {
  generateUUID,
  random32,
  uint32Gte,
  uint32Gt,
  enumerate
} from "../../../utils";

import {
  Chunk,
  ForwardTsnChunk,
  ReConfigChunk,
  InitChunk,
  parsePacket,
  DataChunk,
  serializePacket
} from "./chunk";

// # local constants
const COOKIE_LENGTH = 24;
const COOKIE_LIFETIME = 60;
const MAX_STREAMS = 65535;
const USERDATA_MAX_LENGTH = 1200;

// # protocol constants
const SCTP_DATA_LAST_FRAG = 0x01;
const SCTP_DATA_FIRST_FRAG = 0x02;
const SCTP_DATA_UNORDERED = 0x04;
const SCTP_MAX_ASSOCIATION_RETRANS = 10;
const SCTP_MAX_BURST = 4;
const SCTP_MAX_INIT_RETRANS = 8;
const SCTP_RTO_ALPHA = 1 / 8;
const SCTP_RTO_BETA = 1 / 4;
const SCTP_RTO_INITIAL = 3.0;
const SCTP_RTO_MIN = 1;
const SCTP_RTO_MAX = 60;
const SCTP_TSN_MODULO = 2 ** 32;

// # parameters
const SCTP_STATE_COOKIE = 0x0007;
const SCTP_STR_RESET_OUT_REQUEST = 0x000d;
const SCTP_STR_RESET_RESPONSE = 0x0010;
const SCTP_STR_RESET_ADD_OUT_STREAMS = 0x0011;
const SCTP_SUPPORTED_CHUNK_EXT = 0x8008;
const SCTP_PRSCTP_SUPPORTED = 0xc000;

export class RTCSctpTransport {
  uuid = generateUUID();
  mid?: string;
  bundled = false;

  private dataChannels: { [key: string]: RTCDataChannel } = {};
  get dataChannelsKeys() {
    return Object.keys(this.dataChannels);
  }
  private dataChannelQueue: [RTCDataChannel, number, Buffer][] = [];

  private associationState = State.CLOSED;
  private started = false;
  private state = "new";

  private dataChannelId?: number;

  private localPartialReliability = true;
  private localPort = this.port;
  private localVerificationTag = random32();

  private remotePartialReliability = true;
  private remotePort?: number;
  private remoteVerificationTag = 0;

  // inbound
  private advertisedRwnd = 1024 * 1024;
  private inboundStreams: { [key: number]: InboundStream } = {};
  private inboundStreamsCount = 0;
  private inboundStreamsMax = MAX_STREAMS;
  private sackNeeded = false;

  private outboundStreamsCount = MAX_STREAMS;
  private localTsn = random32();
  private lastReceivedTsn?: number;
  private sackMisOrdered = new Set<number>();
  private sackDuplicates: number[] = [];

  constructor(public transport: RTCDtlsTransport, public port = 5000) {}

  get isServer() {
    return this.transport.transport.role !== "controlling";
  }

  async handleData(data: Buffer) {
    try {
      let expectedTag;

      const [, , verificationTag, chunks] = parsePacket(data);
      const initChunk = chunks.filter(v => v.type === InitChunk.type).length;
      if (initChunk > 0) {
        if (chunks.length != 1) throw new Error();
        expectedTag = 0;
      } else {
        expectedTag = this.localVerificationTag;
      }

      if (verificationTag !== expectedTag) {
        return;
      }

      for (let chunk of chunks) {
        await this.receiveChunk(chunk);
      }
    } catch (error) {}
  }

  async receiveChunk(chunk: Chunk) {
    switch (chunk.type) {
      case DataChunk.type:
        this.receiveDataChunk(chunk as DataChunk);
        break;
    }
  }

  private async receiveDataChunk(chunk: DataChunk) {
    this.sackNeeded = true;

    if (this.markReceived(chunk.tsn)) return;

    const inboundStream = this.getInboundStream(chunk.streamId);

    inboundStream.addChunk(chunk);
    this.advertisedRwnd -= chunk.userData.length;
    // for(let message of inboundStream)
  }

  private getInboundStream(streamId: number) {
    if (!this.inboundStreams[streamId]) {
      this.inboundStreams[streamId] = new InboundStream();
    }
    return this.inboundStreams[streamId];
  }

  private markReceived(tsn: number) {
    if (uint32Gte(this.lastReceivedTsn!, tsn) || this.sackMisOrdered.has(tsn)) {
      this.sackDuplicates.push(tsn);
      return true;
    }

    this.sackMisOrdered.add(tsn);
    for (let tsn of [...this.sackMisOrdered].sort()) {
      if (tsn === tsnPlusOne(this.lastReceivedTsn!)) {
      } else {
        break;
      }
    }

    const isObsolete = (x: number) => uint32Gt(x, this.lastReceivedTsn!);

    this.sackDuplicates = this.sackDuplicates.filter(isObsolete);
    this.sackMisOrdered = new Set([...this.sackMisOrdered].filter(isObsolete));

    return false;
  }

  dataChannelAddNegotiated(channel: RTCDataChannel) {
    if (this.dataChannelsKeys.includes(channel.id.toString()))
      throw new Error();

    this.dataChannels[channel.id.toString()] = channel;

    if (this.associationState === State.ESTABLISHED) {
      channel.setReadyState("open");
    }
  }

  dataChannelOpen(channel: RTCDataChannel) {
    if (channel.id) {
      if (this.dataChannelsKeys.includes(channel.id.toString()))
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
    let data = jspack.Pack("!BBHLHH", [
      DATA_CHANNEL_OPEN,
      channelType,
      priority,
      reliability,
      channel.label.length,
      channel.protocol.length
    ]);
    const send = Buffer.concat([
      Buffer.from(data),
      Buffer.from(channel.label, "utf8"),
      Buffer.from(channel.protocol, "utf8")
    ]);
    this.dataChannelQueue.push([channel, WEBRTC_DCEP, send]);
    this.dataChannelFlush();
  }

  private async dataChannelFlush() {
    if (this.associationState != State.ESTABLISHED) return;
  }

  static getCapabilities() {
    return new RTCSctpCapabilities(65536);
  }

  async start(remotePort: number) {
    if (!this.started) {
      this.started = true;
      this.state = "connecting";
      this.remotePort = remotePort;

      if (this.isServer) {
        this.dataChannelId = 0;
      } else {
        this.dataChannelId = 1;
      }

      this.transport.registerDataReceiver(this);
      if (!this.isServer) {
        await this.init();
      }
    }
  }

  private async init() {
    const chunk = new InitChunk();
    chunk.initiateTag = this.localVerificationTag;
    chunk.advertisedRwnd = this.advertisedRwnd;
    chunk.outboundStreams = this.outboundStreamsCount;
    chunk.inboundStreams = this.inboundStreamsMax;
    chunk.initialTsn = this.localTsn;
    this.setExtensions(chunk.params);
    await this.sendChunk(chunk);

    // TODO
  }

  private setExtensions(params: [number, Buffer][]) {
    const extensions: number[] = [];
    if (this.localPartialReliability) {
      params.push([SCTP_PRSCTP_SUPPORTED, Buffer.from("")]);
      extensions.push(ForwardTsnChunk.type);
    }

    extensions.push(ReConfigChunk.type);
    params.push([SCTP_SUPPORTED_CHUNK_EXT, Buffer.from(extensions)]);
  }

  private async sendChunk(chunk: Chunk) {
    if (!this.remotePort) throw new Error();
    await this.transport.sendData(
      serializePacket(
        this.localPort,
        this.remotePort,
        this.remoteVerificationTag,
        chunk
      )
    );
  }

  private setState(state: State) {
    if (state != this.associationState) {
      this.associationState = state;
    }
    if (state === State.ESTABLISHED) {
      this.state = "connected";
      Object.values(this.dataChannels).forEach(channel => {
        if (channel.negotiated && channel.readyState !== "open") {
          channel.setReadyState("open");
        }
      });
      this.dataChannelFlush();
    } else if (state === State.CLOSED) {
    }
  }
}

class InboundStream {
  reassembly: DataChunk[] = [];
  sequenceNumber = 0;

  addChunk(chunk: DataChunk) {
    if (
      !(this.reassembly.length > 0) ||
      uint32Gt(chunk.tsn, this.reassembly[this.reassembly.length - 1].tsn)
    ) {
      this.reassembly.push(chunk);
      return;
    }

    for (let { i, v } of enumerate(this.reassembly)) {
      if (v.tsn === chunk.tsn) throw new Error("duplicate chunk in reassembly");

      if (uint32Gt(v.tsn, chunk.tsn)) {
        this.reassembly.splice(i, 0, chunk);
        break;
      }
    }
  }

  popMessages() {
    let pos = 0;
    let startPos;
    let expectedTsn: number;
    let ordered: boolean;
    while (pos < this.reassembly.length) {
      const chunk = this.reassembly[pos];
      if (!startPos) {
        ordered = !(chunk.flags && SCTP_DATA_UNORDERED);
        if (!(chunk.flags & SCTP_DATA_FIRST_FRAG)) {
          if (ordered) {
            break;
          } else {
            pos++;
            continue;
          }
        }

        if (ordered && uint32Gt(chunk.streamSeq, this.sequenceNumber)) {
          break;
        }
        expectedTsn = chunk.tsn;
        startPos = pos;
      } else if (chunk.tsn !== expectedTsn!) {
        if (ordered!) {
          break;
        } else {
          startPos = undefined;
          pos++;
          continue;
        }
      }

      if (chunk.flags && SCTP_DATA_LAST_FRAG) {
        const userData = Buffer.from(
          this.reassembly
            .slice(startPos, pos + 1)
            .map(c => c.userData)
            .join("")
        );
        this.reassembly = [
          ...this.reassembly.slice(0, startPos),
          ...this.reassembly.slice(pos + 1)
        ];
        if (ordered! && chunk.streamSeq === this.sequenceNumber) {
          // this.sequenceNumber=
        }
      }
    }
  }
}

export class RTCSctpCapabilities {
  constructor(public maxMessageSize: number) {}
}

function tsnMinusOne(a: number) {
  return (a - 1) % SCTP_TSN_MODULO;
}

function tsnPlusOne(a: number) {
  return (a + 1) % SCTP_TSN_MODULO;
}
