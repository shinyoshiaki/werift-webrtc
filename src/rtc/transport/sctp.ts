import { RTCDataChannel } from "../dataChannel";
import {
  DATA_CHANNEL_RELIABLE,
  DATA_CHANNEL_OPEN,
  WEBRTC_DCEP,
  State
} from "../const";
import { jspack } from "jspack";
import { RTCDtlsTransport } from "./dtls";
import { generateUUID, random32 } from "../../utils";
import crc32 = require("buffer-crc32");

// # local constants
const COOKIE_LENGTH = 24;
const COOKIE_LIFETIME = 60;
const MAX_STREAMS = 65535;
const USERDATA_MAX_LENGTH = 1200;

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
  private dataChannelQueue: [RTCDataChannel, number, Buffer][] = [];
  get dataChannelKeys() {
    return Object.keys(this.dataChannels);
  }
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

  private advertisedRwnd = 1024 * 1024;
  private inboundStreamsMax = MAX_STREAMS;

  private outboundStreamsCount = MAX_STREAMS;
  private localTsn = random32();

  constructor(public transport: RTCDtlsTransport, public port = 5000) {}

  get isServer() {
    return this.transport.transport.role !== "controlling";
  }

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
    let data = jspack.Pack("!BBHLHH", [
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
}

function serializePacket(
  sourcePort: number,
  destinationPort: number,
  verificationTag: number,
  chunk: Chunk
) {
  const header = jspack.Pack("!HHL", [
    sourcePort,
    destinationPort,
    verificationTag
  ]);
  const data = chunk.bytes;
  const checksum = crc32(
    Buffer.concat([header, Buffer.from("\x00\x00\x00\x00"), data])
  );

  return Buffer.concat([header, jspack.Pack("<L", [checksum]), data]);
}

// 3.3.2.  Initiation
class Chunk {
  type = -1;

  constructor(
    public flags = 0,
    public body: Buffer | undefined = Buffer.from("")
  ) {}

  get bytes() {
    if (!this.body) throw new Error();
    const data = Buffer.concat([
      Buffer.from(
        jspack.Pack("!BBH", [this.type, this.flags, this.body.length + 4])
      ),
      this.body,
      ...[...Array(padL(this.body.length))].map(() => Buffer.from("\x00"))
    ]);
    return data;
  }
}
class BaseInitChunk extends Chunk {
  initiateTag: number;
  advertisedRwnd: number;
  outboundStreams: number;
  inboundStreams: number;
  initialTsn: number;
  params: [number, Buffer][];
  constructor(public flags = 0, body?: Buffer) {
    super(flags, body);

    if (body) {
      [
        this.initiateTag,
        this.advertisedRwnd,
        this.outboundStreams,
        this.inboundStreams,
        this.initialTsn
      ] = jspack.Unpack("!LLHHL", body);
      this.params = decodeParams(body.slice(16));
    } else {
      this.initiateTag = 0;
      this.advertisedRwnd = 0;
      this.outboundStreams = 0;
      this.inboundStreams = 0;
      this.initialTsn = 0;
      this.params = [];
    }
  }

  get body() {
    let body = Buffer.from(
      jspack.Pack("!LLHHL", [
        this.initiateTag,
        this.advertisedRwnd,
        this.outboundStreams,
        this.inboundStreams,
        this.initialTsn
      ])
    );
    Buffer.concat([body, encodeParams(this.params)]);
    return body;
  }
}

class InitChunk extends BaseInitChunk {
  static type = 1;
}

class ReConfigChunk extends BaseInitChunk {
  static type = 130;
}

class ForwardTsnChunk extends Chunk {
  static type = 192;
  streams: [number, number][] = [];
  cumulativeTsn: number;

  constructor(public flags = 0, body: Buffer | undefined) {
    super(flags, body);

    if (body) {
      this.cumulativeTsn = jspack.Unpack("!L", body)[0];
      let pos = 4;
      while (pos < body.length) {
        this.streams.push(
          jspack.Unpack("!HH", body.slice(pos)) as [number, number]
        );
        pos += 4;
      }
    } else {
      this.cumulativeTsn = 0;
    }
  }

  get body() {
    const body = jspack.Pack("!L", [this.cumulativeTsn]);
    return Buffer.concat([
      body,
      ...this.streams.map(([id, seq]) =>
        Buffer.from(jspack.Pack("!HH", [id, seq]))
      )
    ]);
  }
}

function decodeParams(body: Buffer): [number, Buffer][] {
  let params: [number, Buffer][] = [];
  let pos = 0;
  while (pos <= body.length - 4) {
    const [type, length] = jspack.Unpack("!HH", body.slice(pos));
    params.push([type, body.slice(pos + 4, pos + length)]);
    pos += length + padL(length);
  }
  return params;
}

function encodeParams(params: [number, Buffer][]) {
  let body = Buffer.from("");
  let padding = Buffer.from("");
  params.forEach(([type, value]) => {
    const length = value.length + 4;
    body = Buffer.concat([
      body,
      padding,
      jspack.Pack("!HH", [type, length]),
      value
    ]);
    padding = Buffer.concat(
      [...Array(padL(length))].map(() => Buffer.from("\x00"))
    );
  });
  return body;
}

function padL(l: number) {
  const m = l % 4;
  return m ? 4 - m : 0;
}

export class RTCSctpCapabilities {
  constructor(public maxMessageSize: number) {}
}
