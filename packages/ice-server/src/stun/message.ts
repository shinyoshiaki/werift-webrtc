import { createHmac, randomBytes } from "crypto";

import { crc32 } from "../../../common/src";

import {
  ATTRIBUTES_BY_NAME,
  ATTRIBUTES_BY_TYPE,
  type AttributeKey,
  type AttributePair,
  AttributeRepository,
  type RawAttribute,
  packXorAddress,
  unpackXorAddress,
} from "./attributes";
import {
  COOKIE,
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
  INTEGRITY_LENGTH,
  type classes,
  isStunMessage,
  type methods,
} from "./const";

export function parseMessage(
  data: Buffer,
  integrityKey?: Buffer,
): Message | undefined {
  if (!isStunMessage(data)) {
    return undefined;
  }

  const messageType = data.readUInt16BE(0);
  const transactionId = Buffer.from(
    data.slice(HEADER_LENGTH - 12, HEADER_LENGTH),
  );

  const attributeRepository = new AttributeRepository();
  const rawAttributes: RawAttribute[] = [];

  for (let pos = HEADER_LENGTH; pos < data.length; ) {
    if (pos + 4 > data.length) {
      return undefined;
    }

    const attrType = data.readUInt16BE(pos);
    const attrLen = data.readUInt16BE(pos + 2);
    const valueStart = pos + 4;
    const valueEnd = valueStart + attrLen;

    if (valueEnd > data.length) {
      return undefined;
    }

    const payload = data.slice(valueStart, valueEnd);
    const padLen = paddingLength(attrLen);
    if (valueEnd + padLen > data.length) {
      return undefined;
    }

    const attribute = ATTRIBUTES_BY_TYPE[attrType];
    if (attribute) {
      const [, attrName, , attrUnpack] = attribute;
      let value: unknown;
      try {
        value =
          attrUnpack.name === unpackXorAddress.name
            ? attrUnpack(payload, transactionId)
            : attrUnpack(payload);
      } catch {
        return undefined;
      }
      attributeRepository.setAttribute(attrName as AttributeKey, value);

      if (attrName === "FINGERPRINT") {
        const fingerprint = messageFingerprint(data.slice(0, pos));
        if (
          attributeRepository.getAttributeValue("FINGERPRINT") !== fingerprint
        ) {
          return undefined;
        }
      } else if (attrName === "MESSAGE-INTEGRITY" && integrityKey) {
        const integrity = messageIntegrity(data.slice(0, pos), integrityKey);
        const expected =
          attributeRepository.getAttributeValue("MESSAGE-INTEGRITY");
        if (!integrity.equals(expected)) {
          return undefined;
        }
      }
    } else {
      rawAttributes.push({
        type: attrType,
        length: attrLen,
        value: Buffer.from(payload),
      });
    }

    pos = valueEnd + padLen;
  }

  return new Message(
    messageType & 0x3eef,
    messageType & 0x0110,
    transactionId,
    attributeRepository.getAttributes(),
    rawAttributes,
  );
}

export class Message extends AttributeRepository {
  constructor(
    public messageMethod: methods,
    public messageClass: classes,
    public transactionId: Buffer = randomBytes(12),
    attributes: AttributePair[] = [],
    public rawAttributes: RawAttribute[] = [],
  ) {
    super(attributes);
  }

  toJSON() {
    return this.json;
  }

  get json() {
    return {
      messageMethod: this.messageMethod,
      messageClass: this.messageClass,
      attributes: this.attributes,
      rawAttributes: this.rawAttributes.map((attribute) => ({
        type: attribute.type,
        length: attribute.value.length,
      })),
    };
  }

  get transactionIdHex() {
    return this.transactionId.toString("hex");
  }

  appendRawAttribute(type: number, value: Buffer) {
    this.rawAttributes.push({ type, value: Buffer.from(value) });
    return this;
  }

  get unknownAttributeTypes() {
    return this.rawAttributes.map((attribute) => attribute.type);
  }

  get bytes() {
    const body = Buffer.concat(
      this.serializedAttributes.map((attribute) =>
        serializeAttribute(attribute.type, attribute.value),
      ),
    );

    const header = Buffer.alloc(8);
    header.writeUInt16BE(this.messageMethod | this.messageClass, 0);
    header.writeUInt16BE(body.length, 2);
    header.writeUInt32BE(COOKIE, 4);

    return Buffer.concat([header, this.transactionId, body]);
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
    return this;
  }

  private get serializedAttributes() {
    const attributes: RawAttribute[] = [];

    for (const attrName of this.attributesKeys) {
      const attrValue = this.getAttributeValue(attrName);
      const [attrType, , attrPack] = ATTRIBUTES_BY_NAME[attrName];
      const value =
        attrPack.name === packXorAddress.name
          ? attrPack(attrValue, this.transactionId)
          : attrPack(attrValue);
      attributes.push({ type: attrType, value });
    }

    attributes.push(
      ...this.rawAttributes.map((attribute) => ({
        type: attribute.type,
        value: Buffer.from(attribute.value),
      })),
    );

    return attributes;
  }
}

function serializeAttribute(type: number, value: Buffer) {
  const attrLen = value.length;
  const padLen = paddingLength(attrLen);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(attrLen, 2);
  return Buffer.concat([header, value, Buffer.alloc(padLen)]);
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
  return (crc32(checkData) ^ FINGERPRINT_XOR) >>> 0;
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
  return rest === 0 ? 0 : 4 - rest;
}
