/**
 * Reject truncated RTP codec payloads before `getBit(undefined)` / RangeError.
 */
export function assertRtpCodecPayloadLength(
  buf: Buffer,
  minLength: number,
  codec: string,
  offset = 0,
) {
  if (buf.length < offset + minLength) {
    throw new Error(
      `${codec} RTP payload truncated: need ${offset + minLength} bytes, got ${buf.length}`,
    );
  }
}
