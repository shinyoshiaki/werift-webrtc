import * as crypto from "crypto";
import debug from "debug";

import { getObjectSummary } from "../../helper";
import { prfEncryptionKeys } from "../prf";
import Cipher, { CipherHeader, SessionType } from "./abstract";
const {
  createDecode,
  encode,
  types: { uint8, uint16be, uint48be },
} = require("binary-data");

const ContentType = uint8;
const ProtocolVersion = uint16be;

const AEADAdditionalData = {
  epoch: uint16be,
  sequence: uint48be,
  type: ContentType,
  version: ProtocolVersion,
  length: uint16be,
};

const err = debug(
  "werift-dtls : packages/dtls/src/cipher/suites/aead.ts : err"
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
      this.hash
    );

    this.clientWriteKey = keys.clientWriteKey;
    this.serverWriteKey = keys.serverWriteKey;
    this.clientNonce = keys.clientNonce;
    this.serverNonce = keys.serverNonce;
  }

  /**
   * Encrypt message.
   */
  encrypt(type: number, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    const iv = isClient ? this.clientNonce : this.serverNonce;
    const writeKey = isClient ? this.clientWriteKey : this.serverWriteKey;
    if (!iv || !writeKey) throw new Error();

    iv.writeUInt16BE(header.epoch, this.nonceImplicitLength);
    iv.writeUIntBE(header.sequenceNumber, this.nonceImplicitLength + 2, 6);

    const explicitNonce = iv.slice(this.nonceImplicitLength);

    const additionalData = {
      epoch: header.epoch,
      sequence: header.sequenceNumber,
      type: header.type,
      version: header.version,
      length: data.length,
    };

    const additionalBuffer = encode(additionalData, AEADAdditionalData).slice();

    const cipher = crypto.createCipheriv(
      this.blockAlgorithm as any,
      writeKey,
      iv,
      {
        authTagLength: this.authTagLength,
      }
    );

    cipher.setAAD(additionalBuffer, {
      plaintextLength: data.length,
    });

    const headPart = cipher.update(data);
    const finalPart = cipher.final();
    const authtag = cipher.getAuthTag();

    return Buffer.concat([explicitNonce, headPart, finalPart, authtag]);
  }

  /**
   * Decrypt message.
   */
  decrypt(type: number, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    const iv = isClient ? this.serverNonce : this.clientNonce;
    const writeKey = isClient ? this.serverWriteKey : this.clientWriteKey;
    if (!iv || !writeKey) throw new Error();

    const final = createDecode(data);

    const explicitNonce = final.readBuffer(this.nonceExplicitLength);
    explicitNonce.copy(iv, this.nonceImplicitLength);

    const encrypted = final.readBuffer(final.length - this.authTagLength);
    const authTag = final.readBuffer(this.authTagLength);

    const additionalData = {
      epoch: header.epoch,
      sequence: header.sequenceNumber,
      type: header.type,
      version: header.version,
      length: encrypted.length,
    };

    const additionalBuffer = encode(additionalData, AEADAdditionalData).slice();

    const decipher = crypto.createDecipheriv(
      this.blockAlgorithm as any,
      writeKey,
      iv,
      {
        authTagLength: this.authTagLength,
      }
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
      err("decrypt failed", error, data, this.summary);
      throw error;
    }
  }
}
