// RFC 6184 - RTP Payload Format for H.264 Video

import { getBit } from "../../../common/src";

export class H264RtpPayload {
  f!: number;
  nri!: number;
  type!: number;

  static deSerialize(buf: Buffer) {
    const h264 = new H264RtpPayload();

    let offset = 0;

    h264.f = getBit(buf[offset], 0);
    h264.nri = getBit(buf[offset], 1, 2);
    h264.type = getBit(buf[offset], 3, 5);

    offset++;

    return h264;
  }

  get isKeyframe() {
    return this.type === NalUnitType.idrSlice;
  }
}

export const NalUnitType = { idrSlice: 5 } as const;
