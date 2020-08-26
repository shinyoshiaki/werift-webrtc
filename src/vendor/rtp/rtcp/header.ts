import { bufferWriter, bufferReader } from "../helper";
import { setBit, getBit } from "../utils";

export const HEADER_SIZE = 4;

export class RtcpHeader {
  version: number = 0;
  padding: boolean = false;
  count: number = 0;
  type: number = 0;
  length: number = 0;

  constructor(props: Partial<RtcpHeader> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    const v_p_rc = { ref: 0 };
    setBit(v_p_rc, 2, 1);
    if (this.padding) setBit(v_p_rc, 1, 2);
    setBit(v_p_rc, this.count, 3, 5);
    const buf = bufferWriter([1, 1, 2], [v_p_rc.ref, this.type, this.length]);
    return buf;
  }

  static deSerialize(buf: Buffer) {
    const [v_p_rc, type, length] = bufferReader(buf, [1, 1, 2]);
    const version = getBit(v_p_rc, 0, 2);
    const padding = getBit(v_p_rc, 2, 1) > 0;
    const count = getBit(v_p_rc, 3, 5);
    return new RtcpHeader({ version, padding, count, type, length });
  }
}

/*
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |V=2|P|    RC   |      PT       |             length            |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */
