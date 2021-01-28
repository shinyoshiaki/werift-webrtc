import { range } from "lodash";
import { bufferReader, bufferWriter } from "../../helper";
import { getBit, BitWriter } from "../../utils";
import { RtcpHeader } from "../header";

/* RTP Extensions for Transport-wide Congestion Control
 * draft-holmer-rmcat-transport-wide-cc-extensions-01

   0               1               2               3
   0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |V=2|P|  FMT=15 |    PT=205     |           length              |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                     SSRC of packet sender                     |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                      SSRC of media source                     |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |      base sequence number     |      packet status count      |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                 reference time                | fb pkt. count |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |          packet chunk         |         packet chunk          |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  .                                                               .
  .                                                               .
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |         packet chunk          |  recv delta   |  recv delta   |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  .                                                               .
  .                                                               .
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |           recv delta          |  recv delta   | zero padding  |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */

export class TransportWideCC {
  static count = 15;
  count = TransportWideCC.count;
  length = 2;

  senderSsrc!: number;
  mediaSsrc!: number;
  baseSequenceNumber!: number;
  packetStatusCount!: number;
  referenceTime!: number;
  fbPktCount!: number;
  packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [];
  recvDeltas: RecvDelta[] = [];
  header!: RtcpHeader;

  constructor(props: Partial<TransportWideCC> = {}) {
    Object.assign(this, props);
    if (!this.header) {
      this.header = new RtcpHeader({
        type: 205,
        count: this.count,
        version: 2,
      });
    }
  }

  static deSerialize(data: Buffer, header: RtcpHeader) {
    const [
      senderSsrc,
      mediaSsrc,
      baseSequenceNumber,
      packetStatusCount,
      referenceTime,
      fbPktCount,
    ] = bufferReader(data, [4, 4, 2, 2, 3, 1]);
    const packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [];
    const recvDeltas: RecvDelta[] = [];

    let packetStatusPos = 16;
    for (let processedPacketNum = 0; processedPacketNum < packetStatusCount; ) {
      const type = getBit(
        data.slice(packetStatusPos, packetStatusPos + 1)[0],
        0,
        1
      );
      let iPacketStatus: RunLengthChunk | StatusVectorChunk | undefined;
      switch (type) {
        case PacketChunk.TypeTCCRunLengthChunk:
          {
            const packetStatus = RunLengthChunk.deSerialize(
              data.slice(packetStatusPos, packetStatusPos + 2)
            );
            iPacketStatus = packetStatus;
            const packetNumberToProcess = Math.min(
              packetStatusCount - processedPacketNum,
              packetStatus.runLength
            );
            if (
              packetStatus.packetStatus ===
                PacketStatus.TypeTCCPacketReceivedSmallDelta ||
              packetStatus.packetStatus ===
                PacketStatus.TypeTCCPacketReceivedLargeDelta
            ) {
              range(packetNumberToProcess).forEach(() => {
                recvDeltas.push(
                  new RecvDelta({ type: packetStatus.packetStatus })
                );
              });
            }
            processedPacketNum += packetNumberToProcess;
          }
          break;
        case PacketChunk.TypeTCCStatusVectorChunk:
          {
            const packetStatus = StatusVectorChunk.deSerialize(
              data.slice(packetStatusPos, packetStatusPos + 2)
            );
            iPacketStatus = packetStatus;
            if (packetStatus.symbolSize === 0) {
              packetStatus.symbolList.forEach((v) => {
                if (v === PacketStatus.TypeTCCPacketReceivedSmallDelta) {
                  recvDeltas.push(
                    new RecvDelta({
                      type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
                    })
                  );
                }
              });
            }
            if (packetStatus.symbolSize === 1) {
              packetStatus.symbolList.forEach((v) => {
                if (
                  v === PacketStatus.TypeTCCPacketReceivedSmallDelta ||
                  v === PacketStatus.TypeTCCPacketReceivedLargeDelta
                ) {
                  recvDeltas.push(
                    new RecvDelta({
                      type: v,
                    })
                  );
                }
              });
            }
            processedPacketNum += packetStatus.symbolList.length;
          }
          break;
      }
      if (!iPacketStatus) throw new Error();
      packetStatusPos += 2;
      packetChunks.push(iPacketStatus);
    }

    let recvDeltaPos = packetStatusPos;
    recvDeltas.forEach((delta) => {
      if (delta.type === PacketStatus.TypeTCCPacketReceivedSmallDelta) {
        delta.deSerialize(data.slice(recvDeltaPos, recvDeltaPos + 1));
        recvDeltaPos++;
      }
      if (delta.type === PacketStatus.TypeTCCPacketReceivedLargeDelta) {
        delta.deSerialize(data.slice(recvDeltaPos, recvDeltaPos + 2));
        recvDeltaPos += 2;
      }
    });

    return new TransportWideCC({
      senderSsrc,
      mediaSsrc,
      baseSequenceNumber,
      packetStatusCount,
      referenceTime,
      fbPktCount,
      recvDeltas,
      packetChunks,
      header,
    });
  }

  serialize() {
    const constBuf = bufferWriter(
      [4, 4, 2, 2, 3, 1],
      [
        this.senderSsrc,
        this.mediaSsrc,
        this.baseSequenceNumber,
        this.packetStatusCount,
        this.referenceTime,
        this.fbPktCount,
      ]
    );

    const chunks = Buffer.concat(
      this.packetChunks.map((chunk) => chunk.serialize())
    );

    const deltas = Buffer.concat(
      this.recvDeltas
        .map((delta) => {
          try {
            return delta.serialize();
          } catch (error) {
            console.log(error.message);
            return undefined;
          }
        })
        .filter((v) => v) as Buffer[]
    );

    const buf = Buffer.concat([constBuf, chunks, deltas]);

    if (this.header.padding && buf.length % 4 !== 0) {
      const rest = 4 - (buf.length % 4);
      const padding = Buffer.alloc(rest);
      padding[padding.length - 1] = padding.length;

      this.header.length = Math.floor((buf.length + padding.length) / 4);
      return Buffer.concat([this.header.serialize(), buf, padding]);
    }

    this.header.length = Math.floor(buf.length / 4);
    return Buffer.concat([this.header.serialize(), buf]);
  }
}

//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |T| S |       Run Length        |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
export class RunLengthChunk {
  type!: number;
  packetStatus!: number;
  runLength!: number;

  constructor(props: Partial<RunLengthChunk> = {}) {
    Object.assign(this, props);
  }

  static deSerialize(data: Buffer) {
    const packetStatus = getBit(data[0], 1, 2);
    const runLength = (getBit(data[0], 3, 5) << 8) + data[1];

    return new RunLengthChunk({ type: 0, packetStatus, runLength });
  }

  serialize() {
    const buf = Buffer.alloc(2);

    const writer = new BitWriter(16);
    writer.set(1, 0, 0);
    writer.set(2, 1, this.packetStatus);
    writer.set(13, 3, this.runLength);

    buf.writeUInt16BE(writer.value);
    return buf;
  }
}

//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |T|S|       symbol list         |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
export class StatusVectorChunk {
  type!: number;
  symbolSize!: number;
  symbolList: number[] = [];

  constructor(props: Partial<StatusVectorChunk> = {}) {
    Object.assign(this, props);
  }

  static deSerialize(data: Buffer) {
    const type = PacketChunk.TypeTCCStatusVectorChunk;
    let symbolSize = getBit(data[0], 1, 1);
    const symbolList: number[] = [];

    switch (symbolSize) {
      case 0:
        range(6).forEach((_, i) => symbolList.push(getBit(data[0], 2 + i, 1)));
        range(8).forEach((_, i) => symbolList.push(getBit(data[1], i, 1)));
        break;
      case 1:
        range(3).forEach((i) => symbolList.push(getBit(data[0], 2 + i * 2, 2)));
        range(4).forEach((i) => symbolList.push(getBit(data[1], i * 2, 2)));
        break;
      default:
        symbolSize = (getBit(data[0], 2, 6) << 8) + data[1];
    }

    return new StatusVectorChunk({ type, symbolSize, symbolList });
  }

  serialize() {
    const buf = Buffer.alloc(2);

    const writer = new BitWriter(16);
    writer.set(1, 0, 1);
    writer.set(1, 1, this.symbolSize);

    const bits = this.symbolSize === 0 ? 1 : 2;

    this.symbolList.forEach((v, i) => {
      const index = bits * i + 2;
      writer.set(bits, index, v);
    });
    buf.writeUInt16BE(writer.value);
    return buf;
  }
}

export class RecvDelta {
  type!: number;
  delta!: number;

  constructor(props: Partial<RecvDelta> = {}) {
    Object.assign(this, props);
  }

  static deSerialize(data: Buffer) {
    let type: number | undefined;
    let delta: number | undefined;

    if (data.length === 1) {
      type = PacketStatus.TypeTCCPacketReceivedSmallDelta;
      delta = 250 * data[0];
    } else if (data.length === 2) {
      type = PacketStatus.TypeTCCPacketReceivedLargeDelta;
      delta = 250 * data.readInt16BE();
    }

    if (type === undefined || delta === undefined) throw new Error();

    return new RecvDelta({ type, delta });
  }

  deSerialize(data: Buffer) {
    const res = RecvDelta.deSerialize(data);
    this.delta = res.delta;
  }

  serialize() {
    const delta = Math.floor(this.delta / 250);
    if (
      this.type === PacketStatus.TypeTCCPacketReceivedSmallDelta &&
      delta >= 0 &&
      delta <= 255
    ) {
      const buf = Buffer.alloc(1);
      buf.writeUInt8(delta);
      return buf;
    }

    if (
      this.type === PacketStatus.TypeTCCPacketReceivedLargeDelta &&
      delta >= -32768 &&
      delta <= 32768
    ) {
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(delta);
      return buf;
    }

    // throw new Error("errDeltaExceedLimit " + delta + " " + this.type);
  }
}

export enum PacketChunk {
  TypeTCCRunLengthChunk,
  TypeTCCStatusVectorChunk,
  packetStatusChunkLength,
}

export enum PacketStatus {
  TypeTCCPacketNotReceived,
  TypeTCCPacketReceivedSmallDelta,
  TypeTCCPacketReceivedLargeDelta,
  TypeTCCPacketReceivedWithoutDelta,
}
