import { jspack } from "jspack";
const crc32c = require("turbo-crc32/crc32c");

export class Chunk {
  static type = -1;

  constructor(
    public flags = 0,
    public body: Buffer | undefined = Buffer.from("")
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
      ...[...Array(padL(this.body.length))].map(() => Buffer.from("\x00"))
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

  set body(_: Buffer) {}

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
      )
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
  streamSeq: number = 0;
  protocol: number = 0;
  userData: Buffer = Buffer.from("");

  abandoned?: boolean;
  acked?: boolean;
  bookSize?: number;
  expiry?: number;
  maxRetransmits?: number;
  misses?: number;
  retransmit?: boolean;
  sentCount?: number;
  sentTime?: number;

  constructor(public flags = 0, body: Buffer | undefined) {
    super(flags, body);
    if (body) {
      [this.tsn, this.streamId, this.streamSeq, this.protocol] = jspack.Unpack(
        "!LHHL",
        body
      );
      this.userData = body.slice(12);
    }
  }

  get bytes() {
    const length = 16 + this.userData.length;
    let data = Buffer.concat([
      Buffer.from(
        jspack.Pack("!BBHLHHL", [
          this.type,
          this.flags,
          length,
          this.tsn,
          this.streamId,
          this.streamSeq,
          this.protocol
        ])
      ),
      this.userData
    ]);
    if (length % 4) {
      data = Buffer.concat([
        data,
        ...[...Array(padL(length))].map(() => Buffer.from("\x00"))
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

export class BaseParamsChunk extends Chunk {
  params: [number, Buffer][] = [];
  constructor(public flags = 0, body: Buffer | undefined) {
    super(flags, body);
    if (body) {
      this.params = decodeParams(body);
    }
  }

  set body(_: Buffer) {}

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
        nbDuplicates
      ] = jspack.Unpack("!LLHH", body);
      this.cumulativeTsn = cumulativeTsn;
      this.advertisedRwnd = advertisedRwnd;

      let pos = 12;

      for (let _ of [...Array(nbGaps)]) {
        this.gaps.push(
          jspack.Unpack("!HH", body.slice(pos)) as [number, number]
        );
        pos += 4;
      }
      for (let _ of [...Array(nbDuplicates)]) {
        this.duplicates.push(jspack.Unpack("!L", body.slice(pos))[0]);
        pos += 4;
      }
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
        this.duplicates.length
      ])
    );
    data = Buffer.concat([
      data,
      ...this.gaps.map(gap => Buffer.from(jspack.Pack("!HH", gap)))
    ]);
    data = Buffer.concat([
      data,
      ...this.duplicates.map(tsn => Buffer.from(jspack.Pack("!L", [tsn])))
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

  set body(_: Buffer) {}
  get body() {
    return Buffer.from(jspack.Pack("!L", [this.cumulativeTsn]));
  }
}

const CHUNK_CLASSES: typeof Chunk[] = [
  DataChunk,
  InitChunk,
  CookieEchoChunk,
  AbortChunk,
  ErrorChunk,
  ForwardTsnChunk,
  HeartbeatChunk,
  ReconfigChunk,
  SackChunk,
  ShutdownChunk
];

export const CHUNK_TYPES = CHUNK_CLASSES.reduce((acc, cur) => {
  acc[cur.type] = cur;
  return acc;
}, {} as { [key: string]: typeof Chunk });

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
      value
    ]);
    padding = Buffer.concat(
      [...Array(padL(length))].map(() => Buffer.from("\x00"))
    );
  });
  return body;
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
      data.slice(12)
    ])
  );

  if (checkSum !== expect) throw new Error("SCTP packet has invalid checksum");

  const chunks = [];
  let pos = 12;
  while (pos + 4 <= data.length) {
    const [chunkType, chunkFlags, chunkLength] = jspack.Unpack(
      "!BBH",
      data.slice(pos)
    );
    const chunkBody = data.slice(pos + 4, pos + chunkLength);
    const ChunkClass = CHUNK_TYPES[chunkType.toString()];
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
