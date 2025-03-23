import * as crypto from "crypto";

import { dumpBuffer, getObjectSummary } from "../../helper";
import { debug } from "../../imports/common";
import { prfEncryptionKeys } from "../prf";
import Cipher, {
  type CipherHeader,
  SessionType,
  type SessionTypes,
} from "./abstract";

const err = debug(
  "werift-dtls : packages/dtls/src/cipher/suites/aead.ts : err",
);

/**
 * This class implements AEAD cipher family.
 */
export default class AEADCipher extends Cipher {
  keyLength = 0;
  nonceLength = 0;
  ivLength = 0;
  authTagLength = 0;

  nonceImplicitLength = 0;
  nonceExplicitLength = 0;

  clientWriteKey?: Buffer;
  serverWriteKey?: Buffer;

  clientNonce?: Buffer;
  serverNonce?: Buffer;

  constructor() {
    super();
  }

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
   * Encrypt message.
   */
  encrypt(type: SessionTypes, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    const iv = isClient ? this.clientNonce : this.serverNonce;
    const writeKey = isClient ? this.clientWriteKey : this.serverWriteKey;
    if (!iv || !writeKey) throw new Error();

    iv.writeUInt16BE(header.epoch, this.nonceImplicitLength);
    iv.writeUIntBE(header.sequenceNumber, this.nonceImplicitLength + 2, 6);

    const explicitNonce = iv.slice(this.nonceImplicitLength);

    const additionalBuffer = this.encodeAdditionalBuffer(header, data.length);

    const cipher = crypto.createCipheriv(
      this.blockAlgorithm as crypto.CipherCCMTypes,
      writeKey,
      iv,
      {
        authTagLength: this.authTagLength,
      },
    );

    cipher.setAAD(additionalBuffer, {
      plaintextLength: data.length,
    });

    const headPart = cipher.update(data);
    const finalPart = cipher.final();
    const authTag = cipher.getAuthTag();

    return Buffer.concat([explicitNonce, headPart, finalPart, authTag]);
  }

  encodeAdditionalBuffer(header: CipherHeader, dataLength: number) {
    const additionalBuffer = Buffer.alloc(13);

    additionalBuffer.writeUInt16BE(header.epoch, 0);
    additionalBuffer.writeUintBE(header.sequenceNumber, 2, 6);
    additionalBuffer.writeUInt8(header.type, 8);
    additionalBuffer.writeUInt16BE(header.version, 9);
    additionalBuffer.writeUInt16BE(dataLength, 11);

    return additionalBuffer;
  }

  /**
   * Decrypt message.
   */
  decrypt(type: SessionTypes, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    const iv = isClient ? this.serverNonce : this.clientNonce;
    const writeKey = isClient ? this.serverWriteKey : this.clientWriteKey;
    if (!iv || !writeKey) throw new Error();

    const explicitNonce = Buffer.from(
      data.subarray(0, this.nonceExplicitLength),
    );
    explicitNonce.copy(iv, this.nonceImplicitLength);

    const encryptedEnd =
      this.nonceExplicitLength + data.length - this.authTagLength;
    const encrypted = data.subarray(
      this.nonceExplicitLength,
      data.length - this.authTagLength,
    );
    const authTag = data.subarray(data.length - this.authTagLength);

    const additionalBuffer = this.encodeAdditionalBuffer(
      header,
      encrypted.length,
    );

    const decipher = crypto.createDecipheriv(
      this.blockAlgorithm as crypto.CipherCCMTypes,
      writeKey,
      iv,
      {
        authTagLength: this.authTagLength,
      },
    );

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
