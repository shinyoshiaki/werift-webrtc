import type { DtlsSocket } from "../imports/dtls";
import {
  type RtcpPacket,
  RtcpPacketConverter,
  RtpPacket,
  SrtcpSession,
  SrtpAuthenticationError,
  SrtpSession,
  debug,
  keyLength,
  saltLength,
} from "../imports/rtp";

const log = debug("werift:packages/webrtc/src/transport/dtls-srtp.ts");

/** @internal Derive SRTP/SRTCP sessions from the negotiated DTLS-SRTP keys. */
export function createSrtpSessions(dtls: DtlsSocket) {
  const profile = dtls.srtp.srtpProfile;
  if (!profile) {
    throw new Error("need srtpProfile");
  }
  log("selected SRTP Profile", profile);

  const { localKey, localSalt, remoteKey, remoteSalt } =
    dtls.extractSessionKeys(keyLength(profile), saltLength(profile));

  const config = {
    keys: {
      localMasterKey: localKey,
      localMasterSalt: localSalt,
      remoteMasterKey: remoteKey,
      remoteMasterSalt: remoteSalt,
    },
    profile,
  };
  return { srtp: new SrtpSession(config), srtcp: new SrtcpSession(config) };
}

/**
 * @internal Decrypt and parse one SRTCP datagram. Packets failing
 * authentication or parsing are dropped (undefined); other errors propagate.
 */
export function decryptRtcp(
  srtcp: SrtcpSession,
  data: Buffer,
): RtcpPacket[] | undefined {
  let dec: Buffer;
  try {
    dec = srtcp.decrypt(data);
  } catch (error) {
    if (error instanceof SrtpAuthenticationError) {
      log("dropping invalid SRTCP packet", error);
      return;
    }
    throw error;
  }
  try {
    return RtcpPacketConverter.deSerialize(dec);
  } catch (error) {
    log("dropping malformed SRTCP packet", error);
    return;
  }
}

/** @internal SRTP counterpart of {@link decryptRtcp}. */
export function decryptRtp(
  srtp: SrtpSession,
  data: Buffer,
): RtpPacket | undefined {
  let dec: Buffer;
  try {
    dec = srtp.decrypt(data);
  } catch (error) {
    if (error instanceof SrtpAuthenticationError) {
      log("dropping invalid SRTP packet", error);
      return;
    }
    throw error;
  }
  try {
    return RtpPacket.deSerialize(dec);
  } catch (error) {
    log("dropping malformed SRTP packet", error);
    return;
  }
}
