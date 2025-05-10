import type { DataChunk } from "./chunk";
import {
  SCTP_DATA_FIRST_FRAG,
  SCTP_DATA_LAST_FRAG,
  SCTP_DATA_UNORDERED,
  SCTP_TSN_MODULO,
} from "./const";
import { enumerate } from "./helper";
import { uint16Add, uint16Gt, uint32Gt, uint32Gte } from "./imports/common";

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
}

export function tsnMinusOne(a: number) {
  return (a - 1) % SCTP_TSN_MODULO;
}

export function tsnPlusOne(a: number) {
  return (a + 1) % SCTP_TSN_MODULO;
}
