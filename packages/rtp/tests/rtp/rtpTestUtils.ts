import { ExtensionProfiles, RtpHeader, RtpPacket } from "../../src/rtp/rtp";
import type { Config } from "../../src/srtp/session";
import { SrtpSession } from "../../src/srtp/srtp";

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

/** Media RTP packet with a small payload (`RtpTimelineRewriter` tests). */
export function createMediaRtpPacket(
  sequenceNumber: number,
  timestamp: number,
  options: { ssrc?: number; payloadType?: number; payload?: Buffer } = {},
) {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber,
      timestamp,
      ssrc: options.ssrc ?? 1111,
      payloadType: options.payloadType ?? 96,
    }),
    options.payload ?? Buffer.from([1, 2, 3, 4]),
  );
}

/** Manually advanced millisecond clock to inject as `now`. */
export function createManualClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** Sender / receiver SRTP sessions sharing one AES_CM_128_HMAC_SHA1_80 key. */
export function createSrtpSessionPair() {
  const key = Buffer.alloc(16, 0x11);
  const salt = Buffer.alloc(14, 0x22);
  const config: Config = {
    profile: 0x0001,
    keys: {
      localMasterKey: key,
      localMasterSalt: salt,
      remoteMasterKey: key,
      remoteMasterSalt: salt,
    },
  };
  return { sender: new SrtpSession(config), receiver: new SrtpSession(config) };
}
