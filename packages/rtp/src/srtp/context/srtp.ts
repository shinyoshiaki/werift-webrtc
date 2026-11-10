import type { RtpHeader } from "../../rtp/rtp";
import { ProtectionProfileAeadAes128Gcm, type SrtpProfile } from "../const";
import { SrtpAuthenticationError, SrtpReplayError } from "../error";
import { parseSrtpRtpHeader } from "../packet";
import { SrtpReplayWindow } from "../replay";
import {
  Context,
  SrtpRolloverCounterOverflowError,
  type SrtpSsrcState,
} from "./context";

export class SrtpContext extends Context {
  /** Receive-side replay windows (RFC 3711 §3.3.2), per SSRC. */
  /** @internal */
  readonly rtpReplayWindows: { [ssrc: number]: SrtpReplayWindow } = {};

  constructor(masterKey: Buffer, masterSalt: Buffer, profile: SrtpProfile) {
    super(masterKey, masterSalt, profile);
  }

  encryptRtp(payload: Buffer, header: RtpHeader) {
    const s = this.getSrtpSsrcState(header.ssrc);
    const roc = this.estimateRolloverCounter(header.sequenceNumber, s);

    const enc = this.cipher.encryptRtp(header, payload, roc);
    this.commitPacketIndex(header.sequenceNumber, roc, s);
    return enc;
  }

  decryptRtp(cipherText: Buffer): [Buffer, RtpHeader] {
    const header = parseSrtpRtpHeader(cipherText, this.rtpAuthTagLength);

    const existingState = this.srtpSSRCStates[header.ssrc];
    const nextState: SrtpSsrcState = existingState
      ? { ...existingState }
      : {
          ssrc: header.ssrc,
          rolloverCounter: 0,
          lastSequenceNumber: 0,
        };
    let roc: number;
    try {
      roc = this.estimateRolloverCounter(header.sequenceNumber, nextState);
    } catch (error) {
      if (error instanceof SrtpRolloverCounterOverflowError) {
        throw new SrtpAuthenticationError(error.message);
      }
      throw error;
    }

    // RFC 3711 §3.3.2: reject replayed / too-old packets by packet index.
    // A new SSRC gets its window only after authentication, so forged
    // packets with arbitrary SSRCs cannot grow receiver state.
    const index = roc * 0x10000 + header.sequenceNumber;
    const existingReplay = this.rtpReplayWindows[header.ssrc];
    if (existingReplay && !existingReplay.check(index)) {
      throw new SrtpReplayError(
        `SRTP replay rejected (ssrc=${header.ssrc} index=${index})`,
      );
    }

    const dec = this.cipher.decryptRtp(cipherText, roc, header);
    const replay = existingReplay ?? new SrtpReplayWindow();
    replay.accept(index);
    this.rtpReplayWindows[header.ssrc] = replay;
    this.commitPacketIndex(header.sequenceNumber, roc, nextState);
    if (existingState) {
      Object.assign(existingState, nextState);
    } else {
      this.srtpSSRCStates[header.ssrc] = nextState;
    }

    return dec;
  }

  private get rtpAuthTagLength() {
    return this.profile === ProtectionProfileAeadAes128Gcm ? 16 : 10;
  }
}
