import { ExtensionProfiles, RtpHeader, RtpPacket } from "../../src/rtp/rtp";

export function createPaddingOnlyRtpPacket(
  options: {
    paddingSize?: number;
    payloadType?: number;
    sequenceNumber?: number;
    timestamp?: number;
    ssrc?: number;
    extensions?: { id: number; payload: Buffer }[];
  } = {},
) {
  const paddingSize = options.paddingSize ?? 8;
  return new RtpPacket(
    new RtpHeader({
      padding: true,
      paddingSize,
      payloadType: options.payloadType ?? 96,
      sequenceNumber: options.sequenceNumber ?? 1,
      timestamp: options.timestamp ?? 0,
      ssrc: options.ssrc ?? 1,
      extension: (options.extensions?.length ?? 0) > 0,
      extensionProfile: ExtensionProfiles.OneByte,
      extensions: options.extensions ?? [],
    }),
    Buffer.alloc(0),
  );
}

export function createRtpWithInvalidPadding(
  paddingSize: number,
  remaining = 1,
) {
  const buf = Buffer.alloc(12 + remaining);
  buf[0] = 0x80 | 0x20; // V=2, P=1
  buf[buf.length - 1] = paddingSize;
  return buf;
}
