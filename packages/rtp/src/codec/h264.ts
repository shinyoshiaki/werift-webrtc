// RFC 6184 - RTP Payload Format for H.264 Video

import { getBit } from "../../../common/src";

export class H264RtpPayload {
  f!: number;
  nri!: number;
  type!: number;

  static deSerialize(buf: Buffer) {
    const h264 = new H264RtpPayload();

    let index = 0;

    h264.f = getBit(buf[index], 0);
    h264.nri = getBit(buf[index], 1, 2);
    h264.type = getBit(buf[index], 3, 5);

    index++;

    return h264;
  }

  get isKeyframe() {
    return this.type === NalUnitType.idrSlice;
  }
}

export const NalUnitType = { idrSlice: 5 } as const;
