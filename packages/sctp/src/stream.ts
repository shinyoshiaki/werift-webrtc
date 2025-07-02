import {
  type DataChunk,
  type ForwardTsnChunk,
  type InitAckChunk,
  type InitChunk,
  parseChunk,
} from "./chunk";
import {
  MAX_STREAMS,
  SCTP_DATA_FIRST_FRAG,
  SCTP_DATA_LAST_FRAG,
  SCTP_DATA_UNORDERED,
} from "./const";
import { enumerate } from "./helper";
import {
  Event,
  uint16Add,
  uint16Gt,
  uint32Gt,
  uint32Gte,
} from "./imports/common";
import { tsnPlusOne } from "./util";

export class StreamManager {
  // inbound
  advertisedRwnd = 1024 * 1024; // Receiver Window
  inboundStreams: { [key: number]: InboundStream } = {};
  _inboundStreamsCount = 0;
  readonly _inboundStreamsMax = MAX_STREAMS;

  // # outbound
  outboundStreamSeq: { [streamId: number]: number } = {};
  _outboundStreamsCount = MAX_STREAMS;

  readonly onReceive = new Event<[number, number, Buffer]>();

  constructor() {}

  get maxChannels() {
    if (this._inboundStreamsCount > 0) {
      return Math.min(this._inboundStreamsCount, this._outboundStreamsCount);
    }
    return undefined;
  }

  updateStreamsCount(init: InitChunk | InitAckChunk) {
    this._inboundStreamsCount = Math.min(
      init.outboundStreams,
      this._inboundStreamsMax,
    );
    this._outboundStreamsCount = Math.min(
      this._outboundStreamsCount,
      init.inboundStreams,
    );
  }

  removeInboundStream(id: number) {
    delete this.inboundStreams[id];
  }

  removeOutboundStreamSeq(id: number) {
    delete this.outboundStreamSeq[id];
  }

  increaseInboundStreamCount(c: number) {
    this._inboundStreamsCount += c;
  }

  incrementOutboundStreamSeq(id: number, ordered?: boolean) {
    const streamSeqNum = ordered ? this.outboundStreamSeq[id] || 0 : 0;
    if (ordered) {
      this.outboundStreamSeq[id] = uint16Add(streamSeqNum, 1);
    }
    return streamSeqNum;
  }

  findOrCreateInboundStream(streamId: number) {
    if (!this.inboundStreams[streamId]) {
      this.inboundStreams[streamId] = new InboundStream();
    }
    return this.inboundStreams[streamId];
  }

  handleForwardTsn(chunk: ForwardTsnChunk, lastReceivedTsn: number) {
    // # update reassembly
    for (const [streamId, streamSeqNum] of chunk.streams) {
      const inboundStream = this.findOrCreateInboundStream(streamId);

      // # advance sequence number and perform delivery
      inboundStream.streamSequenceNumber = uint16Add(streamSeqNum, 1);
      for (const message of inboundStream.popMessages()) {
        this.advertisedRwnd += message[2].length;
        this.receive(...message);
      }
    }

    // # prune obsolete chunks
    for (const inboundStream of Object.values(this.inboundStreams)) {
      this.advertisedRwnd += inboundStream.pruneChunks(lastReceivedTsn);
    }
  }

  private receive(streamId: number, ppId: number, data: Buffer) {
    this.onReceive.execute(streamId, ppId, data);
  }

  handleData(chunk: DataChunk) {
    const inboundStream = this.findOrCreateInboundStream(chunk.streamId);

    inboundStream.addChunk(chunk);
    this.advertisedRwnd -= chunk.userData.length;
    for (const message of inboundStream.popMessages()) {
      this.advertisedRwnd += message[2].length;
      this.receive(...message);
    }
  }

  toDto(): StreamManagerStateDTO {
    return {
      advertisedRwnd: this.advertisedRwnd,
      inboundStreams: Object.fromEntries(
        Object.entries(this.inboundStreams).map(([k, v]) => [k, v.toDto()]),
      ),
      _inboundStreamsCount: this._inboundStreamsCount,
      outboundStreamSeq: this.outboundStreamSeq,
      _outboundStreamsCount: this._outboundStreamsCount,
    };
  }

  static fromDto(dto: StreamManagerStateDTO): StreamManager {
    const streamManager = new StreamManager();
    streamManager.advertisedRwnd = dto.advertisedRwnd;
    streamManager._inboundStreamsCount = dto._inboundStreamsCount;
    streamManager.outboundStreamSeq = dto.outboundStreamSeq;
    streamManager._outboundStreamsCount = dto._outboundStreamsCount;

    for (const [k, v] of Object.entries(dto.inboundStreams)) {
      streamManager.inboundStreams[Number(k)] = InboundStream.fromDto(v);
    }

    return streamManager;
  }
}

export interface StreamManagerStateDTO {
  advertisedRwnd: number;
  inboundStreams: {
    [k: string]: InboundStreamDTO;
  };
  _inboundStreamsCount: number;
  outboundStreamSeq: {
    [streamId: number]: number;
  };
  _outboundStreamsCount: number;
}

export class InboundStream {
  reassembly: DataChunk[] = [];
  streamSequenceNumber = 0; // SSN

  constructor() {}

  addChunk(chunk: DataChunk) {
    if (
      this.reassembly.length === 0 ||
      uint32Gt(chunk.tsn, this.reassembly[this.reassembly.length - 1].tsn)
    ) {
      this.reassembly.push(chunk);
      return;
    }

    for (const [i, v] of enumerate(this.reassembly)) {
      if (v.tsn === chunk.tsn) throw new Error("duplicate chunk in reassembly");

      if (uint32Gt(v.tsn, chunk.tsn)) {
        this.reassembly.splice(i, 0, chunk);
        break;
      }
    }
  }

  *popMessages(): Generator<[number, number, Buffer]> {
    let pos = 0;
    let startPos: number | undefined;
    let expectedTsn: number;
    let ordered: boolean | undefined;
    while (pos < this.reassembly.length) {
      const chunk = this.reassembly[pos];
      if (startPos === undefined) {
        ordered = !(chunk.flags & SCTP_DATA_UNORDERED);
        if (!(chunk.flags & SCTP_DATA_FIRST_FRAG)) {
          if (ordered) {
            break;
          } else {
            pos++;
            continue;
          }
        }
        if (
          ordered &&
          uint16Gt(chunk.streamSeqNum, this.streamSequenceNumber)
        ) {
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

      if (chunk.flags & SCTP_DATA_LAST_FRAG) {
        const arr = this.reassembly
          .slice(startPos, pos + 1)
          .map((c) => c.userData)
          .reduce((acc, cur) => {
            acc.push(cur);
            acc.push(Buffer.from(""));
            return acc;
          }, [] as Buffer[]);
        arr.pop();
        const userData = Buffer.concat(arr);

        this.reassembly = [
          ...this.reassembly.slice(0, startPos),
          ...this.reassembly.slice(pos + 1),
        ];
        if (ordered && chunk.streamSeqNum === this.streamSequenceNumber) {
          this.streamSequenceNumber = uint16Add(this.streamSequenceNumber, 1);
        }
        pos = startPos;
        yield [chunk.streamId, chunk.protocol, userData];
      } else {
        pos++;
      }
      expectedTsn = tsnPlusOne(expectedTsn);
    }
  }

  pruneChunks(tsn: number) {
    // """
    // Prune chunks up to the given TSN.
    // """

    let pos = -1,
      size = 0;

    for (const [i, chunk] of this.reassembly.entries()) {
      if (uint32Gte(tsn, chunk.tsn)) {
        pos = i;
        size += chunk.userData.length;
      } else {
        break;
      }
    }

    this.reassembly = this.reassembly.slice(pos + 1);
    return size;
  }

  toDto(): InboundStreamDTO {
    return {
      reassembly: this.reassembly.map((chunk) => chunk.bytes),
      streamSequenceNumber: this.streamSequenceNumber,
    };
  }

  static fromDto(dto: InboundStreamDTO): InboundStream {
    const stream = new InboundStream();
    stream.reassembly = dto.reassembly.map(
      (chunk) => parseChunk(chunk).chunk as DataChunk,
    );
    stream.streamSequenceNumber = dto.streamSequenceNumber;
    return stream;
  }
}

interface InboundStreamDTO {
  reassembly: Buffer<ArrayBuffer>[];
  streamSequenceNumber: number;
}
