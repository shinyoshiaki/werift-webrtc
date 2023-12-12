import { jspack } from "jspack";

import { RtpHeader, RtpPacket } from "./rtp";

export function unwrapRtx(rtx: RtpPacket, payloadType: number, ssrc: number) {
  const packet = new RtpPacket(
    new RtpHeader({
      payloadType,
      marker: rtx.header.marker,
      sequenceNumber: jspack.Unpack("!H", rtx.payload.subarray(0, 2))[0],
      timestamp: rtx.header.timestamp,
      ssrc,
    }),
    rtx.payload.subarray(2),
  );
  return packet;
}

export function wrapRtx(
  packet: RtpPacket,
  payloadType: number,
  sequenceNumber: number,
  ssrc: number,
) {
  const rtx = new RtpPacket(
    new RtpHeader({
      payloadType,
      marker: packet.header.marker,
      sequenceNumber,
      timestamp: packet.header.timestamp,
      ssrc,
      csrc: packet.header.csrc,
      extensions: packet.header.extensions,
    }),
    Buffer.concat([
      Buffer.from(jspack.Pack("!H", [packet.header.sequenceNumber])),
      packet.payload,
    ]),
  );
  return rtx;
}
