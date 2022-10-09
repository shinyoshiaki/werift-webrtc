import range from "lodash/range";

import { bufferReader, bufferWriter } from "../../../../common/src";
import { RtcpHeader } from "../header";
import { RtcpTransportLayerFeedback } from ".";

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |            PID                |             BLP               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

// Packet ID (PID)
// bitmask of following lost packets (BLP):

export class GenericNack {
  static count = 1;
  readonly count = GenericNack.count;
  header!: RtcpHeader;
  senderSsrc!: number;
  mediaSourceSsrc!: number;
  lost: number[] = [];

  constructor(props: Partial<GenericNack> = {}) {
    Object.assign(this, props);
    if (!this.header) {
      this.header = new RtcpHeader({
        type: RtcpTransportLayerFeedback.type,
        count: this.count,
        version: 2,
      });
    }
  }

  static deSerialize(data: Buffer, header: RtcpHeader) {
    const [senderSsrc, mediaSourceSsrc] = bufferReader(data, [4, 4]);
    const lost = range(8, data.length, 4)
      .map((pos) => {
        const lost: number[] = [];
        const [pid, blp] = bufferReader(data.subarray(pos), [2, 2]);
        lost.push(pid);
        range(0, 16).forEach((diff) => {
          if ((blp >> diff) & 1) {
            lost.push(pid + diff + 1);
          }
        });
        return lost;
      })
      .flatMap((v) => v);

    return new GenericNack({
      header,
      senderSsrc,
      mediaSourceSsrc,
      lost,
    });
  }

  serialize() {
    const ssrcPair = bufferWriter(
      [4, 4],
      [this.senderSsrc, this.mediaSourceSsrc]
    );

    const fci: Buffer[] = [];
    if (this.lost.length > 0) {
      let headPid = this.lost[0],
        blp = 0;
      this.lost.slice(1).forEach((pid) => {
        const diff = pid - headPid - 1;
        if (diff >= 0 && diff < 16) {
          blp |= 1 << diff;
        } else {
          fci.push(bufferWriter([2, 2], [headPid, blp]));
          headPid = pid;
          blp = 0;
        }
      });
      fci.push(bufferWriter([2, 2], [headPid, blp]));
    }
    const buf = Buffer.concat([ssrcPair, Buffer.concat(fci)]);
    this.header.length = buf.length / 4;
    return Buffer.concat([this.header.serialize(), buf]);
  }
}
