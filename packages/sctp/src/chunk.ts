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

import debug from "debug";
import { jspack } from "jspack";
import Event from "rx.mini";
const crc32c = require("turbo-crc32/crc32c");
const log = debug("werift/sctp/chunk");

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
    private _body: Buffer | undefined = Buffer.from("")
  ) {}

  get type() {
    return Chunk.type;
  }

  get bytes() {
    if (!this.body) throw new Error();

    const data = Buffer.concat([
      Buffer.from(
        jspack.Pack("!BBH", [this.type, this.flags, this.body.length + 4])
      ),
      this.body,
      ...[...Array(padL(this.body.length))].map(() => Buffer.from("\x00")),
    ]);
    return data;
  }
}

export class BaseInitChunk extends Chunk {
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
        this.initialTsn,
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
        this.initialTsn,
      ])
    );
    body = Buffer.concat([body, encodeParams(this.params)]);
    return body;
  }
}

export class InitChunk extends BaseInitChunk {
  static type = 1;

  get type() {
    return InitChunk.type;
  }
}

export class InitAckChunk extends BaseInitChunk {
  static type = 2;

  get type() {
    return InitAckChunk.type;
  }
}

export class ReConfigChunk extends BaseInitChunk {
  static type = 130;

  get type() {
    return ReConfigChunk.type;
  }
}

export class ForwardTsnChunk extends Chunk {
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

  get type() {
    return ForwardTsnChunk.type;
  }

  set body(_: Buffer) {}

  get body() {
    const body = Buffer.from(jspack.Pack("!L", [this.cumulativeTsn]));
    return Buffer.concat([
      body,
      ...this.streams.map(([id, seq]) =>
        Buffer.from(jspack.Pack("!HH", [id, seq]))
      ),
    ]);
  }
}

export class DataChunk extends Chunk {
  static type = 0;
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
  readonly onTransmit = new Event();

  constructor(public flags = 0, body: Buffer | undefined) {
    super(flags, body);
    if (body) {
      [
        this.tsn,
        this.streamId,
        this.streamSeqNum,
        this.protocol,
      ] = jspack.Unpack("!LHHL", body);
      this.userData = body.slice(12);
    }
  }

  get bytes() {
    if (!this.userData.length) log("userData is empty");

    const length = 16 + this.userData.length;
    let data = Buffer.concat([
      Buffer.from(
        jspack.Pack("!BBHLHHL", [
          this.type,
          this.flags,
          length,
          this.tsn,
          this.streamId,
          this.streamSeqNum,
          this.protocol,
        ])
      ),
      this.userData,
    ]);
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
  static type = 10;

  get type() {
    return CookieEchoChunk.type;
  }
}

export class CookieAckChunk extends Chunk {
  static type = 11;

  get type() {
    return CookieAckChunk.type;
  }
}

export class BaseParamsChunk extends Chunk {
  params: [number, Buffer][] = [];
  constructor(public flags = 0, body: Buffer | undefined = undefined) {
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
  static type = 6;

  get type() {
    return AbortChunk.type;
  }
}

export class ErrorChunk extends BaseParamsChunk {
  static type = 9;

  get type() {
    return ErrorChunk.type;
  }
}

export class HeartbeatChunk extends BaseParamsChunk {
  static type = 4;

  get type() {
    return HeartbeatChunk.type;
  }
}

export class HeartbeatAckChunk extends BaseParamsChunk {
  static type = 5;

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
  static type = 130;

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

  constructor(public flags = 0, body: Buffer | undefined) {
    super(flags, body);

    if (body) {
      const [
        cumulativeTsn,
        advertisedRwnd,
        nbGaps,
        nbDuplicates,
      ] = jspack.Unpack("!LLHH", body);
      this.cumulativeTsn = cumulativeTsn;
      this.advertisedRwnd = advertisedRwnd;

      let pos = 12;

      [...Array(nbGaps)].forEach(() => {
        this.gaps.push(
          jspack.Unpack("!HH", body.slice(pos)) as [number, number]
        );
        pos += 4;
      });

      [...Array(nbDuplicates)].forEach(() => {
        this.duplicates.push(jspack.Unpack("!L", body.slice(pos))[0]);
        pos += 4;
      });
    }
  }

  get bytes() {
    const length = 16 + 4 * (this.gaps.length + this.duplicates.length);
    let data = Buffer.from(
      jspack.Pack("!BBHLLHH", [
        this.type,
        this.flags,
        length,
        this.cumulativeTsn,
        this.advertisedRwnd,
        this.gaps.length,
        this.duplicates.length,
      ])
    );
    data = Buffer.concat([
      data,
      ...this.gaps.map((gap) => Buffer.from(jspack.Pack("!HH", gap))),
    ]);
    data = Buffer.concat([
      data,
      ...this.duplicates.map((tsn) => Buffer.from(jspack.Pack("!L", [tsn]))),
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

  constructor(public flags = 0, body: Buffer | undefined) {
    super(flags, body);

    if (body) {
      this.cumulativeTsn = jspack.Unpack("!L", body)[0];
    }
  }

  get body() {
    return Buffer.from(jspack.Pack("!L", [this.cumulativeTsn]));
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

const CHUNK_CLASSES: typeof Chunk[] = [
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
  {}
);

function padL(l: number) {
  const m = l % 4;
  return m ? 4 - m : 0;
}

function encodeParams(params: [number, Buffer][]) {
  let body = Buffer.from("");
  let padding = Buffer.from("");
  params.forEach(([type, value]) => {
    const length = value.length + 4;
    body = Buffer.concat([
      body,
      padding,
      Buffer.from(jspack.Pack("!HH", [type, length])),
      value,
    ]);
    padding = Buffer.concat(
      [...Array(padL(length))].map(() => Buffer.from("\x00"))
    );
  });
  return body;
}

export function decodeParams(body: Buffer): [number, Buffer][] {
  const params: [number, Buffer][] = [];
  let pos = 0;
  while (pos <= body.length - 4) {
    const [type, length] = jspack.Unpack("!HH", body.slice(pos));
    params.push([type, body.slice(pos + 4, pos + length)]);
    pos += length + padL(length);
  }
  return params;
}

export function parsePacket(data: Buffer): [number, number, number, Chunk[]] {
  if (data.length < 12)
    throw new Error("SCTP packet length is less than 12 bytes");

  const [sourcePort, destinationPort, verificationTag] = jspack.Unpack(
    "!HHL",
    data
  );

  const checkSum = data.readUInt32LE(8);

  const expect = crc32c(
    Buffer.concat([
      data.slice(0, 8),
      Buffer.from("\x00\x00\x00\x00"),
      data.slice(12),
    ])
  );

  if (checkSum !== expect) throw new Error("SCTP packet has invalid checksum");

  const chunks: Chunk[] = [];
  let pos = 12;
  while (pos + 4 <= data.length) {
    const [chunkType, chunkFlags, chunkLength] = jspack.Unpack(
      "!BBH",
      data.slice(pos)
    );
    const chunkBody = data.slice(pos + 4, pos + chunkLength);
    const ChunkClass = CHUNK_BY_TYPE[chunkType.toString()];
    if (ChunkClass) {
      chunks.push(new ChunkClass(chunkFlags, chunkBody));
    } else {
      throw new Error("unknown");
    }
    pos += chunkLength + padL(chunkLength);
  }
  return [sourcePort, destinationPort, verificationTag, chunks];
}

export function serializePacket(
  sourcePort: number,
  destinationPort: number,
  verificationTag: number,
  chunk: Chunk
) {
  const header = Buffer.from(
    jspack.Pack("!HHL", [sourcePort, destinationPort, verificationTag])
  );
  const body = chunk.bytes;

  const checksum: number = crc32c(
    Buffer.concat([header, Buffer.from("\x00\x00\x00\x00"), body])
  );
  const checkSumBuf = Buffer.alloc(4);
  checkSumBuf.writeUInt32LE(checksum, 0);

  const packet = Buffer.concat([header, checkSumBuf, body]);

  return packet;
}
