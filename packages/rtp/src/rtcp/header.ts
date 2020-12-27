import { bufferReader, bufferWriter } from "../helper";
import { BitWriter, getBit } from "../utils";

export const HEADER_SIZE = 4;

/*
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |V=2|P|    RC   |      PT       |             length            |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */

export class RtcpHeader {
  version: number = 2;
  padding: boolean = false;
  count: number = 0;
  type: number = 0;
  length: number = 0;

  constructor(props: Partial<RtcpHeader> = {}) {
    Object.assign(this, props);
  }

  serialize() {
    const v_p_rc = new BitWriter(8);
    v_p_rc.set(2, 0, this.version);
    if (this.padding) v_p_rc.set(1, 2, 1);
    v_p_rc.set(5, 3, this.count);
    const buf = bufferWriter([1, 1, 2], [v_p_rc.value, this.type, this.length]);
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
