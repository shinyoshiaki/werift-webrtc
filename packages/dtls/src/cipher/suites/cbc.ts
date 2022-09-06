import * as crypto from "crypto";
import debug from "debug";

import { dumpBuffer, getObjectSummary } from "../../helper";
import { prfEncryptionKeys } from "../prf";
import Cipher, { CipherHeader, SessionType, SessionTypes } from "./abstract";
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
export default class CBCCipher extends Cipher {
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
      this.hashAlgorithm
    );

    this.clientWriteKey = keys.clientWriteKey;
    this.serverWriteKey = keys.serverWriteKey;
    this.clientNonce = keys.clientNonce;
    this.serverNonce = keys.serverNonce;
  }

  prevEncBlock?: Buffer;

  /**
   * Encrypt message.
   */
  encrypt(type: SessionTypes, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    let iv = isClient ? this.clientNonce : this.serverNonce;
    const writeKey = isClient ? this.clientWriteKey : this.serverWriteKey;
    if (!iv || !writeKey) throw new Error();

    iv.writeUInt16BE(header.epoch, this.nonceImplicitLength);
    iv.writeUIntBE(header.sequenceNumber, this.nonceImplicitLength + 2, 6);

    if (this.prevEncBlock) {
      iv = this.prevEncBlock;
    }

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
      this.blockAlgorithm as crypto.CipherCCMTypes,
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
    const authTag = cipher.getAuthTag();

    const res = Buffer.concat([explicitNonce, headPart, finalPart, authTag]);
    this.prevEncBlock = res;
    return res;
  }

  prevDecBlock?: Buffer;
  /**
   * Decrypt message.
   */
  decrypt(type: SessionTypes, data: Buffer, header: CipherHeader) {
    const isClient = type === SessionType.CLIENT;
    let iv = isClient ? this.serverNonce : this.clientNonce;
    const writeKey = isClient ? this.serverWriteKey : this.clientWriteKey;
    if (!iv || !writeKey) throw new Error();

    if (this.prevDecBlock) {
      iv = this.prevDecBlock;
    } else {
      iv = Buffer.alloc(16);
    }

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
      this.blockAlgorithm as crypto.CipherCCMTypes,
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
      const res =
        finalPart.length > 0 ? Buffer.concat([headPart, finalPart]) : headPart;
      this.prevDecBlock = res;
      return res;
    } catch (error) {
      err(
        "decrypt failed",
        error,
        type,
        dumpBuffer(data),
        header,
        this.summary
      );
      throw error;
    }
  }
}
