import { RtpHeader, RtpPacket } from "./rtp";

export function unwrapRtx(rtx: RtpPacket, payloadType: number, ssrc: number) {
  const packet = new RtpPacket(
    new RtpHeader({
      payloadType,
      marker: rtx.header.marker,
      sequenceNumber: rtx.payload.readUInt16BE(0),
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
  const originalSequence = Buffer.allocUnsafe(2);
  originalSequence.writeUInt16BE(packet.header.sequenceNumber, 0);
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
    Buffer.concat([originalSequence, packet.payload]),
  );
  return rtx;
}
