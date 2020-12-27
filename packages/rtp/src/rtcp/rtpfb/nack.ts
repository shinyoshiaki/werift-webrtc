import { range } from "lodash";
import { bufferReader, bufferWriter } from "../../helper";
import { RtcpHeader } from "../header";

export class GenericNack {
  static count = 1;
  readonly count = GenericNack.count;
  header: RtcpHeader;
  senderSsrc: number;
  mediaSsrc: number;
  lost: number[] = [];

  constructor(props: Partial<GenericNack> = {}) {
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
    const [senderSsrc, mediaSsrc] = bufferReader(data, [4, 4]);
    const lost = range(8, data.length, 4)
      .map((pos) => {
        const lost: number[] = [];
        const [pid, blp] = bufferReader(data.slice(pos), [2, 2]);
        lost.push(pid);
        range(0, 16).forEach((d) => {
          if ((blp >> d) & 1) {
            lost.push(pid + d + 1);
          }
        });
        return lost;
      })
      .flatMap((v) => v);

    return new GenericNack({ header, senderSsrc, mediaSsrc, lost });
  }

  serialize() {
    const ssrcs = bufferWriter([4, 4], [this.senderSsrc, this.mediaSsrc]);
    const fics: Buffer[] = [];
    if (this.lost.length > 0) {
      let pid = this.lost[0],
        blp = 0;
      this.lost.slice(1).forEach((p) => {
        const d = p - pid - 1;
        if (d < 16) {
          blp |= 1 << d;
        } else {
          fics.push(bufferWriter([2, 2], [pid, blp]));
          pid = p;
          blp = 0;
        }
      });
      fics.push(bufferWriter([2, 2], [pid, blp]));
    }
    const buf = Buffer.concat([ssrcs, Buffer.concat(fics)]);
    this.header.length = buf.length / 4;
    return Buffer.concat([this.header.serialize(), buf]);
  }
}
