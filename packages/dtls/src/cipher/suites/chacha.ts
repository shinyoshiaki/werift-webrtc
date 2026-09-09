import { type CipherCCMTypes, createCipheriv, createDecipheriv } from "crypto";

import { dumpBuffer, getObjectSummary } from "../../helper";
import { debug } from "../../imports/common";
import { prfEncryptionKeys } from "../prf";
import { type CipherHeader, SessionType, type SessionTypes } from "./abstract";
import AEADCipher from "./aead";

const err = debug(
  "werift-dtls : packages/dtls/src/cipher/suites/chacha.ts : err",
);

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "chacha20-poly1305" as CipherCCMTypes;

/**
 * AEAD_CHACHA20_POLY1305 cipher for TLS/DTLS 1.2 (RFC 7905).
 *
 * Differs from the AES-GCM AEAD scheme in two ways:
 *  - the per-record nonce is the 12-byte write IV XOR'd with the 64-bit
 *    record sequence number (left-padded to 12 bytes), and
 *  - there is no explicit nonce on the wire (record_iv_length === 0), so an
 *    encrypted record is just ciphertext followed by the 16-byte auth tag.
 */
export default class AEADChaCha20Poly1305Cipher extends AEADCipher {
  get summary() {
    return getObjectSummary(this);
  }

  init(masterSecret: Buffer, serverRandom: Buffer, clientRandom: Buffer) {
    const keys = prfEncryptionKeys(
      masterSecret,
      clientRandom,
      serverRandom,
      this.keyLength,
      this.ivLength,
      this.nonceLength,
      this.hashAlgorithm,
    );

    this.clientWriteKey = keys.clientWriteKey;
    this.serverWriteKey = keys.serverWriteKey;
    this.clientNonce = keys.clientNonce;
    this.serverNonce = keys.serverNonce;
  }

  /**
   * RFC 7905, sec. 2: nonce = write_IV XOR (0x00000000 || seq_num).
   * For DTLS the 64-bit sequence is the 16-bit epoch concatenated with the
   * 48-bit record sequence number.
   */
  private computeNonce(fixedIv: Buffer, header: CipherHeader) {
    const padded = Buffer.alloc(NONCE_LENGTH, 0);
    padded.writeUInt16BE(header.epoch, 4);
    padded.writeUIntBE(header.sequenceNumber, 6, 6);

    const nonce = Buffer.alloc(NONCE_LENGTH);
    for (let i = 0; i < NONCE_LENGTH; i += 1) {
      nonce[i] = fixedIv[i] ^ padded[i];
    }
    return nonce;
  }

  encrypt(type: SessionTypes, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    const fixedIv = isClient ? this.clientNonce : this.serverNonce;
    const writeKey = isClient ? this.clientWriteKey : this.serverWriteKey;
    if (!fixedIv || !writeKey) throw new Error();

    const nonce = this.computeNonce(fixedIv, header);
    const additionalBuffer = this.encodeAdditionalBuffer(header, data.length);

    const cipher = createCipheriv(ALGORITHM, writeKey, nonce, {
      authTagLength: TAG_LENGTH,
    });

    cipher.setAAD(additionalBuffer, {
      plaintextLength: data.length,
    });

    const headPart = cipher.update(data);
    const finalPart = cipher.final();
    const authTag = cipher.getAuthTag();

    // RFC 7905: no explicit nonce is transmitted.
    return Buffer.concat([headPart, finalPart, authTag]);
  }

  decrypt(type: SessionTypes, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    const fixedIv = isClient ? this.serverNonce : this.clientNonce;
    const writeKey = isClient ? this.serverWriteKey : this.clientWriteKey;
    if (!fixedIv || !writeKey) throw new Error();

    const encrypted = data.subarray(0, data.length - TAG_LENGTH);
    const authTag = data.subarray(data.length - TAG_LENGTH);

    const nonce = this.computeNonce(fixedIv, header);
    const additionalBuffer = this.encodeAdditionalBuffer(
      header,
      encrypted.length,
    );

    const decipher = createDecipheriv(ALGORITHM, writeKey, nonce, {
      authTagLength: TAG_LENGTH,
    });

    decipher.setAuthTag(authTag);
    decipher.setAAD(additionalBuffer, {
      plaintextLength: encrypted.length,
    });

    const headPart = decipher.update(encrypted);
    try {
      const finalPart = decipher.final();
      return finalPart.length > 0
        ? Buffer.concat([headPart, finalPart])
        : headPart;
    } catch (error) {
      err(
        "decrypt failed",
        error,
        type,
        dumpBuffer(data),
        header,
        this.summary,
      );
      throw error;
    }
  }
}
