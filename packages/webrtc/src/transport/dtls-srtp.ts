import type { DtlsSocket } from "../imports/dtls";
import {
  debug,
  keyLength,
  type RtcpPacket,
  RtcpPacketConverter,
  RtpPacket,
  SrtcpSession,
  SrtpAuthenticationError,
  SrtpSession,
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
 * @internal SRTP / SRTCP keys of a DTLS association and the read / write
 * permissions they are used under. Keys alone never grant access: reading
 * needs peer (SDP fingerprint) authentication, writing needs it too unless
 * the WARP early-server policy allows 0.5-RTT output.
 */
export class SrtpAccess {
  private sessions?: { srtp: SrtpSession; srtcp: SrtcpSession };
  private readable = false;
  private writable = false;

  get keysInstalled(): boolean {
    return this.sessions !== undefined;
  }

  /** Decrypting and delivering inbound media is allowed. */
  get canRead(): boolean {
    return this.readable;
  }

  /** Encrypting and sending media is allowed. */
  get canWrite(): boolean {
    return this.writable;
  }

  /** Derive the sessions from `dtls` once; later calls return the same pair. */
  installKeys(dtls: DtlsSocket): { srtp: SrtpSession; srtcp: SrtcpSession } {
    this.sessions ??= createSrtpSessions(dtls);
    return this.sessions;
  }

  /** Re-derive both permissions from key availability and the auth state. */
  update({
    peerAuthenticated,
    earlyServerWriteAllowed,
  }: {
    peerAuthenticated: boolean;
    earlyServerWriteAllowed: boolean;
  }): void {
    this.readable = this.keysInstalled && peerAuthenticated;
    this.writable =
      this.keysInstalled && (peerAuthenticated || earlyServerWriteAllowed);
  }

  /** Stop reading and writing until the next {@link update}. */
  revoke(): void {
    this.readable = false;
    this.writable = false;
  }

  /** Stop writing (early output withdrawn) until the next {@link update}. */
  revokeWrite(): void {
    this.writable = false;
  }
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
