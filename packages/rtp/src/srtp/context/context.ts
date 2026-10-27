import { createCipheriv, createHmac } from "crypto";

import type { CipherAesBase } from "../cipher";
import { CipherAesCtr } from "../cipher/ctr";
import { CipherAesGcm } from "../cipher/gcm";
import {
  ProtectionProfileAeadAes128Gcm,
  ProtectionProfileAes128CmHmacSha1_80,
  type SrtpProfile,
} from "../const";

/** AES-128-ECB single-block encrypt for SRTP KDF (no padding). */
export function aes128EcbEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, Buffer.alloc(0));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export class Context {
  srtpSSRCStates: { [ssrc: number]: SrtpSsrcState } = {};
  srtpSessionKey: Buffer;
  srtpSessionSalt: Buffer;
  srtpSessionAuthTag: Buffer;
  srtpSessionAuth: ReturnType<typeof createHmac>;
  srtcpSSRCStates: { [ssrc: number]: SrtcpSSRCState } = {};
  srtcpSessionKey: Buffer;
  srtcpSessionSalt: Buffer;
  srtcpSessionAuthTag: Buffer;
  srtcpSessionAuth: ReturnType<typeof createHmac>;

  cipher: CipherAesBase;

  constructor(
    public masterKey: Buffer,
    public masterSalt: Buffer,
    public profile: SrtpProfile,
  ) {
    {
      // AES-ECB plaintext require 16byte
      // so need to padding to 14 byte
      const diff = 14 - masterSalt.length;
      if (diff > 0) {
        this.masterSalt = Buffer.concat([masterSalt, Buffer.alloc(diff)]);
      }
    }

    this.srtpSessionKey = this.generateSessionKey(0);
    this.srtpSessionSalt = this.generateSessionSalt(2);
    this.srtpSessionAuthTag = this.generateSessionAuthTag(1);
    this.srtpSessionAuth = createHmac("sha1", this.srtpSessionAuthTag);

    this.srtcpSessionKey = this.generateSessionKey(3);
    this.srtcpSessionSalt = this.generateSessionSalt(5);
    this.srtcpSessionAuthTag = this.generateSessionAuthTag(4);
    this.srtcpSessionAuth = createHmac("sha1", this.srtcpSessionAuthTag);

    switch (profile) {
      case ProtectionProfileAes128CmHmacSha1_80:
        this.cipher = new CipherAesCtr(
          this.srtpSessionKey,
          this.srtpSessionSalt,
          this.srtcpSessionKey,
          this.srtcpSessionSalt,
          this.srtpSessionAuthTag,
          this.srtcpSessionAuthTag,
        );
        break;
      case ProtectionProfileAeadAes128Gcm:
        this.cipher = new CipherAesGcm(
          this.srtpSessionKey,
          this.srtpSessionSalt,
          this.srtcpSessionKey,
          this.srtcpSessionSalt,
        );
        break;
    }
  }

  generateSessionKey(label: number) {
    let sessionKey = Buffer.from(this.masterSalt);

    const labelAndIndexOverKdr = Buffer.from([
      label,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    for (
      let i = labelAndIndexOverKdr.length - 1, j = sessionKey.length - 1;
      i >= 0;
      i--, j--
    ) {
      sessionKey[j] = sessionKey[j] ^ labelAndIndexOverKdr[i];
    }

    sessionKey = Buffer.concat([sessionKey, Buffer.from([0x00, 0x00])]);
    return aes128EcbEncrypt(this.masterKey, sessionKey);
  }

  generateSessionSalt(label: number) {
    let sessionSalt: Buffer = Buffer.from(this.masterSalt);
    const labelAndIndexOverKdr = Buffer.from([
      label,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    for (
      let i = labelAndIndexOverKdr.length - 1, j = sessionSalt.length - 1;
      i >= 0;
      i--, j--
    ) {
      sessionSalt[j] = sessionSalt[j] ^ labelAndIndexOverKdr[i];
    }
    sessionSalt = Buffer.concat([sessionSalt, Buffer.from([0x00, 0x00])]);
    sessionSalt = aes128EcbEncrypt(this.masterKey, sessionSalt);
    return sessionSalt.subarray(0, 14);
  }

  generateSessionAuthTag(label: number) {
    const sessionAuthTag = Buffer.from(this.masterSalt);
    const labelAndIndexOverKdr = Buffer.from([
      label,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    for (
      let i = labelAndIndexOverKdr.length - 1, j = sessionAuthTag.length - 1;
      i >= 0;
      i--, j--
    ) {
      sessionAuthTag[j] = sessionAuthTag[j] ^ labelAndIndexOverKdr[i];
    }
    let firstRun: Buffer = Buffer.concat([
      sessionAuthTag,
      Buffer.from([0x00, 0x00]),
    ]);
    let secondRun: Buffer = Buffer.concat([
      sessionAuthTag,
      Buffer.from([0x00, 0x01]),
    ]);
    firstRun = aes128EcbEncrypt(this.masterKey, firstRun);
    secondRun = aes128EcbEncrypt(this.masterKey, secondRun);
    return Buffer.concat([firstRun, secondRun.subarray(0, 4)]);
  }

  getSrtpSsrcState(ssrc: number) {
    let s = this.srtpSSRCStates[ssrc];
    if (s) return s;
    s = {
      ssrc,
      rolloverCounter: 0,
      lastSequenceNumber: 0,
    };
    this.srtpSSRCStates[ssrc] = s;
    return s;
  }

  getSrtcpSsrcState(ssrc: number) {
    let s = this.srtcpSSRCStates[ssrc];
    if (s) return s;
    s = {
      srtcpIndex: 0,
      ssrc,
    };
    this.srtcpSSRCStates[ssrc] = s;
    return s;
  }

  // RFC 3711 3.3.1.  Packet Index Determination, and ROC, s_l Update
  // The state keeps only the highest accepted index (ROC, s_l). Each packet
  // estimates its own ROC from it, so out-of-order packets, duplicates and
  // retransmissions never shift the ROC of later packets.

  /**
   * Estimates the ROC of a packet without touching the state
   * (RFC 3711 Appendix A).
   *
   * A packet guessed to belong to the cycle before ROC=0 is clamped to 0
   * (negative ROC is not representable, see #94).
   *
   * @throws {SrtpRolloverCounterOverflowError} when the packet belongs to the
   * cycle after ROC=0xFFFFFFFF (re-keying is required).
   */
  estimateRolloverCounter(sequenceNumber: number, s: SrtpSsrcState): number {
    const roc = guessRolloverCounter(sequenceNumber, s);
    if (roc < 0) {
      return 0;
    }
    if (roc > MaxRolloverCounter) {
      throw new SrtpRolloverCounterOverflowError(s.ssrc);
    }
    return roc;
  }

  /**
   * Advances the highest accepted index (ROC, s_l) only when the packet is
   * newer than it. Older packets, duplicates and packets whose ROC was clamped
   * leave the state unchanged.
   */
  commitPacketIndex(
    sequenceNumber: number,
    rolloverCounter: number,
    s: SrtpSsrcState,
  ) {
    if (!s.rolloverHasProcessed) {
      s.rolloverHasProcessed = true;
      s.rolloverCounter = rolloverCounter;
      s.lastSequenceNumber = sequenceNumber;
      return;
    }
    const delta =
      packetIndex(rolloverCounter, sequenceNumber) -
      packetIndex(s.rolloverCounter, s.lastSequenceNumber);
    // A newer packet is at most half a cycle ahead of the highest index.
    if (delta > 0 && delta <= HalfSequenceNumberCycle) {
      s.rolloverCounter = rolloverCounter;
      s.lastSequenceNumber = sequenceNumber;
    }
  }

  /**
   * @deprecated Use {@link Context.estimateRolloverCounter} and
   * {@link Context.commitPacketIndex}. Kept for compatibility.
   * @returns the ROC to use for this packet
   */
  updateRolloverCount(sequenceNumber: number, s: SrtpSsrcState) {
    const roc = this.estimateRolloverCounter(sequenceNumber, s);
    this.commitPacketIndex(sequenceNumber, roc, s);
    return roc;
  }

  generateSrtpAuthTag(buf: Buffer, roc: number) {
    this.srtpSessionAuth = createHmac("sha1", this.srtpSessionAuthTag);
    const rocRaw = Buffer.alloc(4);
    rocRaw.writeUInt32BE(roc);

    return this.srtpSessionAuth
      .update(buf)
      .update(rocRaw)
      .digest()
      .slice(0, 10);
  }

  index(ssrc: number) {
    const s = this.srtcpSSRCStates[ssrc];
    if (!s) {
      return 0;
    }
    return s.srtcpIndex;
  }

  setIndex(ssrc: number, index: number) {
    const s = this.getSrtcpSsrcState(ssrc);
    s.srtcpIndex = index % 0x7fffffff;
  }
}

export interface SrtpSsrcState {
  ssrc: number;
  /** ROC of the highest accepted packet index (RFC 3711 ROC) */
  rolloverCounter: number;
  /** whether the highest accepted packet index has been initialized */
  rolloverHasProcessed?: boolean;
  /** sequence number of the highest accepted packet index (RFC 3711 s_l) */
  lastSequenceNumber: number;
}

export type SrtcpSSRCState = {
  srtcpIndex: number;
  ssrc: number;
};

export class SrtpRolloverCounterOverflowError extends Error {
  constructor(ssrc: number) {
    super(
      `SRTP rollover counter exhausted for ssrc ${ssrc}, re-keying required`,
    );
    this.name = "SrtpRolloverCounterOverflowError";
  }
}

const SequenceNumberCycle = 0x10000;
const HalfSequenceNumberCycle = 0x8000;
const MaxRolloverCounter = 0xffffffff;

/** 48bit packet index (fits in Number.MAX_SAFE_INTEGER) */
const packetIndex = (rolloverCounter: number, sequenceNumber: number) =>
  rolloverCounter * SequenceNumberCycle + sequenceNumber;

/** RFC 3711 Appendix A. may return -1 or 2^32 */
const guessRolloverCounter = (sequenceNumber: number, s: SrtpSsrcState) => {
  if (!s.rolloverHasProcessed) {
    return 0;
  }
  const { rolloverCounter, lastSequenceNumber } = s;
  if (lastSequenceNumber < HalfSequenceNumberCycle) {
    return sequenceNumber - lastSequenceNumber > HalfSequenceNumberCycle
      ? rolloverCounter - 1
      : rolloverCounter;
  }
  return lastSequenceNumber - HalfSequenceNumberCycle > sequenceNumber
    ? rolloverCounter + 1
    : rolloverCounter;
};
