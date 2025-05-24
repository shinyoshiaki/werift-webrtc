// ID Value    Chunk Type
// -----       ----------
// 0          - Payload Data (DATA)
// 1          - Initiation (INIT)
// 2          - Initiation Acknowledgement (INIT ACK)
// 3          - Selective Acknowledgement (SACK)
// 4          - Heartbeat Request (HEARTBEAT)
// 5          - Heartbeat Acknowledgement (HEARTBEAT ACK)
// 6          - Abort (ABORT)
// 7          - Shutdown (SHUTDOWN)
// 8          - Shutdown Acknowledgement (SHUTDOWN ACK)
// 9          - Operation Error (ERROR)
// 10         - State Cookie (COOKIE ECHO)
// 11         - Cookie Acknowledgement (COOKIE ACK)
// 12         - Reserved for Explicit Congestion Notification Echo
//              (ECNE)
// 13         - Reserved for Congestion Window Reduced (CWR)
// 14         - Shutdown Complete (SHUTDOWN COMPLETE)
// 15 to 62   - available
// 63         - reserved for IETF-defined Chunk Extensions
// 64 to 126  - available
// 127        - reserved for IETF-defined Chunk Extensions
// 128 to 190 - available
// 191        - reserved for IETF-defined Chunk Extensions
// 192 to 254 - available
// 255        - reserved for IETF-defined Chunk Extensions

import crc32c from "turbo-crc32/crc32c.js";

export class Chunk {
  public get body(): Buffer | undefined {
    return this._body;
  }
  public set body(value: Buffer | undefined) {
    this._body = value;
  }
  static type = -1;

  constructor(
    public flags = 0,
    private _body: Buffer | undefined = Buffer.from(""),
  ) {}

  get type() {
    return Chunk.type;
  }

  get bytes() {
    if (!this.body) {
      throw new Error("Chunk body is undefined");
    }

    const header = Buffer.alloc(4);
    header.writeUInt8(this.type, 0);
    header.writeUInt8(this.flags, 1);
    header.writeUInt16BE(this.body.length + 4, 2);

    const data = Buffer.concat([
      header,
      this.body,
      ...[...Array(padL(this.body.length))].map(() => Buffer.from("\x00")),
    ]);
    return data;
  }

  static parse(data: Buffer) {
    if (data.length < 4) {
      throw new Error("Chunk header length is less than 4 bytes");
    }
    const type = data.readUInt8(0);
    const flags = data.readUInt8(1);
    const length = data.readUInt16BE(2);
    const body = data.subarray(4, length);
    return { type, flags, length, body };
  }
}

export class BaseInitChunk extends Chunk {
  initiateTag: number;
  advertisedRwnd: number;
  outboundStreams: number;
  inboundStreams: number;
  initialTsn: number;
  params: [number, Buffer][];

  constructor(
    public flags = 0,
    body?: Buffer,
  ) {
    super(flags, body);

    if (body) {
      this.initiateTag = body.readUInt32BE(0);
      this.advertisedRwnd = body.readUInt32BE(4);
      this.outboundStreams = body.readUInt16BE(8);
      this.inboundStreams = body.readUInt16BE(10);
      this.initialTsn = body.readUInt32BE(12);
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
    const body = Buffer.alloc(16);
    body.writeUInt32BE(this.initiateTag, 0);
    body.writeUInt32BE(this.advertisedRwnd, 4);
    body.writeUInt16BE(this.outboundStreams, 8);
    body.writeUInt16BE(this.inboundStreams, 10);
    body.writeUInt32BE(this.initialTsn, 12);
    return Buffer.concat([body, encodeParams(this.params)]);
  }
}

export class InitChunk extends BaseInitChunk {
  static type = 1 as const;

  get type() {
    return InitChunk.type;
  }
}

export class InitAckChunk extends BaseInitChunk {
  static type = 2 as const;

  get type() {
    return InitAckChunk.type;
  }
}

export class ReConfigChunk extends BaseInitChunk {
  static type = 130 as const;

  get type() {
    return ReConfigChunk.type;
  }
}

export class ForwardTsnChunk extends Chunk {
  static type = 192 as const;
  streams: [number, number][] = [];
  cumulativeTsn: number;

  constructor(
    public flags = 0,
    body: Buffer | undefined,
  ) {
    super(flags, body);

    if (body) {
      this.cumulativeTsn = body.readUInt32BE(0);
      let pos = 4;
      while (pos < body.length) {
        this.streams.push([body.readUInt16BE(pos), body.readUInt16BE(pos + 2)]);
        pos += 4;
      }
    } else {
      this.cumulativeTsn = 0;
    }
  }

  get type() {
    return ForwardTsnChunk.type;
  }

  set body(_: Buffer) {}

  get body() {
    const body = Buffer.alloc(4);
    body.writeUInt32BE(this.cumulativeTsn, 0);
    return Buffer.concat([
      body,
      ...this.streams.map(([id, seq]) => {
        const streamBuffer = Buffer.alloc(4);
        streamBuffer.writeUInt16BE(id, 0);
        streamBuffer.writeUInt16BE(seq, 2);
        return streamBuffer;
      }),
    ]);
  }
}

export class DataChunk extends Chunk {
  static type = 0 as const;
  get type() {
    return DataChunk.type;
  }
  tsn: number = 0;
  streamId: number = 0;
  streamSeqNum: number = 0;
  protocol: number = 0;
  userData: Buffer = Buffer.from("");
  abandoned: boolean = false;
  acked: boolean = false;
  misses: number = 0;
  retransmit: boolean = false;
  sentCount: number = 0;
  bookSize: number = 0;
  expiry?: number;
  maxRetransmits?: number;
  sentTime?: number;

  constructor(
    public flags = 0,
    body: Buffer | undefined,
  ) {
    super(flags, body);
    if (body) {
      this.tsn = body.readUInt32BE(0);
      this.streamId = body.readUInt16BE(4);
      this.streamSeqNum = body.readUInt16BE(6);
      this.protocol = body.readUInt32BE(8);
      this.userData = body.slice(12);
    }
  }

  get bytes() {
    const length = 16 + this.userData.length;
    const header = Buffer.alloc(16);
    header.writeUInt8(this.type, 0);
    header.writeUInt8(this.flags, 1);
    header.writeUInt16BE(length, 2);
    header.writeUInt32BE(this.tsn, 4);
    header.writeUInt16BE(this.streamId, 8);
    header.writeUInt16BE(this.streamSeqNum, 10);
    header.writeUInt32BE(this.protocol, 12);

    let data = Buffer.concat([header, this.userData]);
    if (length % 4) {
      data = Buffer.concat([
        data,
        ...[...Array(padL(length))].map(() => Buffer.from("\x00")),
      ]);
    }
    return data;
  }
}

export class CookieEchoChunk extends Chunk {
  static type = 10 as const;

  get type() {
    return CookieEchoChunk.type;
  }
}

export class CookieAckChunk extends Chunk {
  static type = 11 as const;

  get type() {
    return CookieAckChunk.type;
  }
}

export class BaseParamsChunk extends Chunk {
  params: [number, Buffer][] = [];
  constructor(
    public flags = 0,
    body: Buffer | undefined = undefined,
  ) {
    super(flags, body);
    if (body) {
      this.params = decodeParams(body);
    }
  }

  get body() {
    return encodeParams(this.params);
  }
}

export class AbortChunk extends BaseParamsChunk {
  static type = 6 as const;

  get type() {
    return AbortChunk.type;
  }
}

export class ErrorChunk extends BaseParamsChunk {
  static type = 9 as const;
  static readonly CODE = {
    InvalidStreamIdentifier: 1,
    MissingMandatoryParameter: 2,
    StaleCookieError: 3,
    OutofResource: 4,
    UnresolvableAddress: 5,
    UnrecognizedChunkType: 6,
    InvalidMandatoryParameter: 7,
    UnrecognizedParameters: 8,
    NoUserData: 9,
    CookieReceivedWhileShuttingDown: 10,
    RestartofanAssociationwithNewAddresses: 11,
    UserInitiatedAbort: 12,
    ProtocolViolation: 13,
  } as const;

  get type() {
    return ErrorChunk.type;
  }

  get descriptions() {
    return this.params.map(([code, body]) => {
      const name = (Object.entries(ErrorChunk.CODE).find(
        ([, num]) => num === code,
      ) || [])[0];
      return { name, body };
    });
  }
}

export class HeartbeatChunk extends BaseParamsChunk {
  static type = 4 as const;

  get type() {
    return HeartbeatChunk.type;
  }
}

export class HeartbeatAckChunk extends BaseParamsChunk {
  static type = 5 as const;

  get type() {
    return HeartbeatAckChunk.type;
  }
}

// https://tools.ietf.org/html/rfc6525#section-3.1
// chunkReconfig represents an SCTP Chunk used to reconfigure streams.
//
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// | Type = 130    |  Chunk Flags  |      Chunk Length             |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// \                                                               \
// /                  Re-configuration Parameter                   /
// \                                                               \
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// \                                                               \
// /             Re-configuration Parameter (optional)             /
// \                                                               \
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
export class ReconfigChunk extends BaseParamsChunk {
  static type = 130 as const;

  get type() {
    return ReconfigChunk.type;
  }
}

export class SackChunk extends Chunk {
  static type = 3;
  get type() {
    return SackChunk.type;
  }

  gaps: [number, number][] = [];
  duplicates: number[] = [];
  cumulativeTsn = 0;
  advertisedRwnd = 0;

  constructor(
    public flags = 0,
    body: Buffer | undefined,
  ) {
    super(flags, body);

    if (body) {
      this.cumulativeTsn = body.readUInt32BE(0);
      this.advertisedRwnd = body.readUInt32BE(4);
      const nbGaps = body.readUInt16BE(8);
      const nbDuplicates = body.readUInt16BE(10);

      let pos = 12;

      [...Array(nbGaps)].forEach(() => {
        this.gaps.push([body.readUInt16BE(pos), body.readUInt16BE(pos + 2)]);
        pos += 4;
      });

      [...Array(nbDuplicates)].forEach(() => {
        this.duplicates.push(body.readUInt32BE(pos));
        pos += 4;
      });
    }
  }

  get bytes() {
    const length = 16 + 4 * (this.gaps.length + this.duplicates.length);
    const header = Buffer.alloc(16);
    header.writeUInt8(this.type, 0);
    header.writeUInt8(this.flags, 1);
    header.writeUInt16BE(length, 2);
    header.writeUInt32BE(this.cumulativeTsn, 4);
    header.writeUInt32BE(this.advertisedRwnd, 8);
    header.writeUInt16BE(this.gaps.length, 12);
    header.writeUInt16BE(this.duplicates.length, 14);

    let data = Buffer.concat([
      header,
      ...this.gaps.map((gap) => {
        const gapBuffer = Buffer.alloc(4);
        gapBuffer.writeUInt16BE(gap[0], 0);
        gapBuffer.writeUInt16BE(gap[1], 2);
        return gapBuffer;
      }),
    ]);
    data = Buffer.concat([
      data,
      ...this.duplicates.map((tsn) => {
        const tsnBuffer = Buffer.alloc(4);
        tsnBuffer.writeUInt32BE(tsn, 0);
        return tsnBuffer;
      }),
    ]);
    return data;
  }
}

export class ShutdownChunk extends Chunk {
  static type = 7;
  get type() {
    return ShutdownChunk.type;
  }

  cumulativeTsn = 0;

  constructor(
    public flags = 0,
    body: Buffer | undefined,
  ) {
    super(flags, body);

    if (body) {
      this.cumulativeTsn = body.readUInt32BE(0);
    }
  }

  get body() {
    const body = Buffer.alloc(4);
    body.writeUInt32BE(this.cumulativeTsn, 0);
    return body;
  }
}

export class ShutdownAckChunk extends Chunk {
  static type = 8;
  get type() {
    return ShutdownAckChunk.type;
  }
}

export class ShutdownCompleteChunk extends Chunk {
  static type = 14;
  get type() {
    return ShutdownCompleteChunk.type;
  }
}

const CHUNK_CLASSES: (typeof Chunk)[] = [
  DataChunk,
  InitChunk,
  InitAckChunk,
  SackChunk,
  HeartbeatChunk,
  HeartbeatAckChunk,
  AbortChunk,
  ShutdownChunk,
  ShutdownAckChunk,
  ErrorChunk,
  CookieEchoChunk,
  CookieAckChunk,
  ShutdownCompleteChunk,
  ReconfigChunk,
  ForwardTsnChunk,
];

export const CHUNK_BY_TYPE = CHUNK_CLASSES.reduce(
  (acc: { [key: string]: typeof Chunk }, cur) => {
    acc[cur.type] = cur;
    return acc;
  },
  {},
);

function padL(l: number) {
  const m = l % 4;
  return m ? 4 - m : 0;
}

function encodeParams(params: [number, Buffer][]) {
  let body = Buffer.from("");
  let padding = Buffer.from("");
  for (const [type, value] of params) {
    const length = value.length + 4;
    const paramHeader = Buffer.alloc(4);
    paramHeader.writeUInt16BE(type, 0);
    paramHeader.writeUInt16BE(length, 2);
    body = Buffer.concat([body, padding, paramHeader, value]);
    padding = Buffer.concat(
      [...Array(padL(length))].map(() => Buffer.from("\x00")),
    );
  }
  return body;
}

export function decodeParams(body: Buffer): [number, Buffer][] {
  const params: [number, Buffer][] = [];
  let pos = 0;
  while (pos <= body.length - 4) {
    const type = body.readUInt16BE(pos);
    const length = body.readUInt16BE(pos + 2);
    params.push([type, body.slice(pos + 4, pos + length)]);
    pos += length + padL(length);
  }
  return params;
}

export const parseChunk = (data: Buffer) => {
  const { type, flags, length, body } = Chunk.parse(data);

  const ChunkClass = CHUNK_BY_TYPE[type.toString()];
  if (!ChunkClass) {
    throw new Error("unknown");
  }

  return {
    chunk: new ChunkClass(flags, body),
    length,
  };
};

export function parsePacket(data: Buffer): [number, number, number, Chunk[]] {
  if (data.length < 12)
    throw new Error("SCTP packet length is less than 12 bytes");

  const sourcePort = data.readUInt16BE(0);
  const destinationPort = data.readUInt16BE(2);
  const verificationTag = data.readUInt32BE(4);

  const checkSum = data.readUInt32LE(8);

  const expect = crc32c(
    Buffer.concat([
      data.slice(0, 8),
      Buffer.from("\x00\x00\x00\x00"),
      data.slice(12),
    ]),
  );

  if (checkSum !== expect) throw new Error("SCTP packet has invalid checksum");

  const chunks: Chunk[] = [];
  let pos = 12;
  while (pos + 4 <= data.length) {
    const { length, chunk } = parseChunk(data.subarray(pos));
    chunks.push(chunk);
    pos += length + padL(length);
  }
  return [sourcePort, destinationPort, verificationTag, chunks];
}

export function serializePacket(
  sourcePort: number,
  destinationPort: number,
  verificationTag: number,
  chunk: Chunk,
) {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(sourcePort, 0);
  header.writeUInt16BE(destinationPort, 2);
  header.writeUInt32BE(verificationTag, 4);

  const body = chunk.bytes;

  const checksum: number = crc32c(
    Buffer.concat([header, Buffer.from("\x00\x00\x00\x00"), body]),
  );
  const checkSumBuf = Buffer.alloc(4);
  checkSumBuf.writeUInt32LE(checksum, 0);

  const packet = Buffer.concat([header, checkSumBuf, body]);

  return packet;
}
