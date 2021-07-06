import crc32 from "buffer-crc32";
import { createHmac } from "crypto";
import { jspack } from "jspack";

import { bufferXor, randomTransactionId } from "../helper";
import {
  ATTRIBUTES_BY_NAME,
  ATTRIBUTES_BY_TYPE,
  packXorAddress,
  unpackXorAddress,
} from "./attributes";
import {
  ATTRIBUTES,
  classes,
  COOKIE,
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
  INTEGRITY_LENGTH,
  methods,
} from "./const";

export function parseMessage(
  data: Buffer,
  integrityKey?: Buffer
): Message | undefined {
  if (data.length < HEADER_LENGTH) {
    return undefined;
  }
  const [messageType, length] = jspack.Unpack(
    "!HHI",
    data.slice(0, HEADER_LENGTH)
  );

  const transactionId = Buffer.from(
    data.slice(HEADER_LENGTH - 12, HEADER_LENGTH)
  );

  if (data.length !== HEADER_LENGTH + length) {
    return undefined;
  }

  const attributes: { [key: string]: any } = {};

  for (let pos = HEADER_LENGTH; pos <= data.length - 4; ) {
    const [attrType, attrLen] = jspack.Unpack("!HH", data.slice(pos, pos + 4));
    const v = data.slice(pos + 4, pos + 4 + attrLen);
    const padLen = 4 * Math.floor((attrLen + 3) / 4) - attrLen;
    const attributesTypes = Object.keys(ATTRIBUTES_BY_TYPE);
    if (attributesTypes.includes(attrType.toString())) {
      const [, attrName, , attrUnpack] = ATTRIBUTES_BY_TYPE[attrType];
      if (attrUnpack.name === unpackXorAddress.name) {
        attributes[attrName] = attrUnpack(v, transactionId);
      } else {
        attributes[attrName] = attrUnpack(v);
      }

      if (attrName === "FINGERPRINT") {
        const fingerprint = messageFingerprint(data.slice(0, pos));
        if (attributes[attrName] !== fingerprint) {
          return undefined;
        }
      } else if (attrName === "MESSAGE-INTEGRITY") {
        if (integrityKey) {
          const integrity = messageIntegrity(data.slice(0, pos), integrityKey);
          if (!integrity.equals(attributes[attrName])) {
            return undefined;
          }
        }
      }
    }
    pos += 4 + attrLen + padLen;
  }

  return new Message(
    messageType & 0x3eef,
    messageType & 0x0110,
    transactionId,
    attributes
  );
}

export class Message {
  constructor(
    public messageMethod: methods,
    public messageClass: classes,
    public transactionId: Buffer = randomTransactionId(),
    public attributes: { [key in typeof ATTRIBUTES[number]]?: any } = {}
  ) {}

  get attributesKeys(): typeof ATTRIBUTES[number][] {
    return Object.keys(this.attributes) as any;
  }

  get transactionIdHex() {
    return this.transactionId.toString("hex");
  }

  get bytes() {
    let data = Buffer.from([]);
    for (const attrName of this.attributesKeys) {
      const attrValue = (this.attributes as any)[attrName];
      const [attrType, , attrPack] = ATTRIBUTES_BY_NAME[attrName];
      const v =
        attrPack.name === packXorAddress.name
          ? attrPack(attrValue, this.transactionId)
          : attrPack(attrValue);
      const attrLen = v.length;
      const padLen = 4 * Math.floor((attrLen + 3) / 4) - attrLen;
      data = Buffer.concat([
        data,
        Buffer.from(jspack.Pack("!HH", [attrType, attrLen])),
        v,
        ...[...Array(padLen)].map(() => Buffer.from("\x00")),
      ]);
    }
    const buf = Buffer.from(
      jspack.Pack("!HHI", [
        this.messageMethod | this.messageClass,
        data.length,
        COOKIE,
      ])
    );

    return Buffer.concat([buf, this.transactionId, data]);
  }

  addFingerprint() {
    this.attributes["FINGERPRINT"] = messageFingerprint(this.bytes);
  }

  addMessageIntegrity(key: Buffer) {
    this.attributes["MESSAGE-INTEGRITY"] = messageIntegrity(this.bytes, key);
  }
}

const setBodyLength = (data: Buffer, length: number) => {
  return Buffer.concat([
    data.slice(0, 2),
    Buffer.from(jspack.Pack("!H", [length])),
    data.slice(4),
  ]);
};

function messageFingerprint(data: Buffer) {
  const checkData = setBodyLength(
    data,
    data.length - HEADER_LENGTH + FINGERPRINT_LENGTH
  );
  const crc32Buf = crc32(checkData);
  const xorBuf = Buffer.alloc(4);
  xorBuf.writeInt32BE(FINGERPRINT_XOR, 0);
  const fingerprint = bufferXor(crc32Buf, xorBuf);
  return fingerprint.readUInt32BE(0);
}

function messageIntegrity(data: Buffer, key: Buffer) {
  const checkData = setBodyLength(
    data,
    data.length - HEADER_LENGTH + INTEGRITY_LENGTH
  );
  return Buffer.from(
    createHmac("sha1", key).update(checkData).digest("hex"),
    "hex"
  );
}
