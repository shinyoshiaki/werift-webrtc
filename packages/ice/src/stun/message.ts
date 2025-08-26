import { createHmac } from "crypto";
//@ts-ignore
import crc32 from "buffer-crc32";

import { bufferXor, randomTransactionId } from "../helper.js";
import {
  ATTRIBUTES_BY_NAME,
  ATTRIBUTES_BY_TYPE,
  type AttributeKey,
  type AttributePair,
  AttributeRepository,
  packXorAddress,
  unpackXorAddress,
} from "./attributes.js";
import {
  COOKIE,
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
  INTEGRITY_LENGTH,
  classes,
  methods,
} from "./const.js";

export function parseMessage(
  data: Buffer,
  integrityKey?: Buffer,
): Message | undefined {
  if (data.length < HEADER_LENGTH) {
    return undefined;
  }

  const length = data.readUint16BE(2);

  if (data.length !== HEADER_LENGTH + length) {
    return undefined;
  }

  const messageType = data.readUint16BE(0);
  const transactionId = Buffer.from(
    data.slice(HEADER_LENGTH - 12, HEADER_LENGTH),
  );

  const attributeRepository = new AttributeRepository();

  for (let pos = HEADER_LENGTH; pos <= data.length - 4; ) {
    const attrType = data.readUInt16BE(pos);
    const attrLen = data.readUInt16BE(pos + 2);
    const payload = data.slice(pos + 4, pos + 4 + attrLen);
    const padLen = 4 * Math.floor((attrLen + 3) / 4) - attrLen;
    const attributesTypes = Object.keys(ATTRIBUTES_BY_TYPE);
    if (attributesTypes.includes(attrType.toString())) {
      const [, attrName, , attrUnpack] = ATTRIBUTES_BY_TYPE[attrType];
      if (attrUnpack.name === unpackXorAddress.name) {
        attributeRepository.setAttribute(
          attrName as AttributeKey,
          attrUnpack(payload, transactionId),
        );
      } else {
        attributeRepository.setAttribute(
          attrName as AttributeKey,
          attrUnpack(payload),
        );
      }

      if (attrName === "FINGERPRINT") {
        const fingerprint = messageFingerprint(data.slice(0, pos));
        const expect = attributeRepository.getAttributeValue("FINGERPRINT");
        if (expect !== fingerprint) {
          return undefined;
        }
      } else if (attrName === "MESSAGE-INTEGRITY") {
        if (integrityKey) {
          const integrity = messageIntegrity(data.slice(0, pos), integrityKey);
          const expect =
            attributeRepository.getAttributeValue("MESSAGE-INTEGRITY");
          if (!integrity.equals(expect)) {
            return undefined;
          }
        }
      }
    }
    pos += 4 + attrLen + padLen;
  }

  const attributes = attributeRepository.getAttributes();
  attributeRepository.clear();

  return new Message(
    messageType & 0x3eef,
    messageType & 0x0110,
    transactionId,
    attributes,
  );
}

export class Message extends AttributeRepository {
  constructor(
    public messageMethod: methods,
    public messageClass: classes,
    public transactionId: Buffer = randomTransactionId(),
    attributes: AttributePair[] = [],
  ) {
    super(attributes);
  }

  toJSON() {
    return this.json;
  }

  get json() {
    return {
      messageMethod: methods[this.messageMethod],
      messageClass: classes[this.messageClass],
      attributes: this.attributes,
    };
  }

  get transactionIdHex() {
    return this.transactionId.toString("hex");
  }

  get bytes() {
    let data = Buffer.from([]);
    for (const attrName of this.attributesKeys) {
      const attrValue = this.getAttributeValue(attrName);
      const [attrType, , attrPack] = ATTRIBUTES_BY_NAME[attrName];
      const v =
        attrPack.name === packXorAddress.name
          ? attrPack(attrValue, this.transactionId)
          : attrPack(attrValue);
      const attrLen = v.length;
      const padLen = 4 * Math.floor((attrLen + 3) / 4) - attrLen;
      const attrHeader = Buffer.alloc(4);
      attrHeader.writeUInt16BE(attrType, 0);
      attrHeader.writeUInt16BE(attrLen, 2);
      data = Buffer.concat([data, attrHeader, v, Buffer.alloc(padLen, 0)]);
    }
    const buf = Buffer.alloc(8);
    buf.writeUInt16BE(this.messageMethod | this.messageClass, 0);
    buf.writeUInt16BE(data.length, 2);
    buf.writeUInt32BE(COOKIE, 4);

    return Buffer.concat([buf, this.transactionId, data]);
  }

  addMessageIntegrity(key: Buffer) {
    this.setAttribute("MESSAGE-INTEGRITY", this.messageIntegrity(key));
    return this;
  }

  messageIntegrity(key: Buffer) {
    const checkData = setBodyLength(
      this.bytes,
      this.bytes.length - HEADER_LENGTH + INTEGRITY_LENGTH,
    );
    return Buffer.from(
      createHmac("sha1", key).update(checkData).digest("hex"),
      "hex",
    );
  }

  addFingerprint() {
    this.setAttribute("FINGERPRINT", messageFingerprint(this.bytes));
  }
}

const setBodyLength = (data: Buffer, length: number) => {
  const output = Buffer.alloc(data.length);
  data.copy(output, 0, 0, 2);
  output.writeUInt16BE(length, 2);
  data.copy(output, 4, 4);
  return output;
};

function messageFingerprint(data: Buffer) {
  const checkData = setBodyLength(
    data,
    data.length - HEADER_LENGTH + FINGERPRINT_LENGTH,
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
    data.length - HEADER_LENGTH + INTEGRITY_LENGTH,
  );
  return Buffer.from(
    createHmac("sha1", key).update(checkData).digest("hex"),
    "hex",
  );
}

export function paddingLength(length: number) {
  const rest = length % 4;
  if (rest === 0) {
    return 0;
  } else {
    return 4 - rest;
  }
}
