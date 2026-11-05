import { RtpHeader, RtpPacket } from "./rtp";

/**
 * Append RFC 3550 padding to an RTP payload.
 * The last octet is the padding length (including itself); preceding pad bytes are zero.
 * @param paddingSize total padding octets in [1, 255]
 */
export function appendRfc3550Padding(
  payload: Buffer,
  paddingSize: number,
): Buffer {
  if (paddingSize < 1 || paddingSize > 255) {
    throw new Error(`invalid RTP padding size: ${paddingSize}`);
  }
  const pad = Buffer.alloc(paddingSize);
  pad.writeUInt8(paddingSize, paddingSize - 1);
  return payload.length === 0 ? pad : Buffer.concat([payload, pad]);
}

/**
 * Padding-only RTP on the **RTX** SSRC / payload type (pin libwebrtc
 * `GeneratePadding` with RTX). The sequence is assigned at send time.
 */
export function createRtxPaddingPacket({
  paddingSize,
  timestamp,
  payloadType,
  ssrc,
}: {
  paddingSize: number;
  timestamp: number;
  payloadType: number;
  ssrc: number;
}): RtpPacket {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber: 0,
      timestamp,
      payloadType,
      ssrc,
      extension: true,
      extensions: [],
      marker: false,
      padding: true,
      paddingSize,
      payloadOffset: 12,
    }),
    Buffer.alloc(0),
  );
}
