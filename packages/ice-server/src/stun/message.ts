import { createHmac, randomBytes, timingSafeEqual } from "crypto";

import { crc32 } from "../../../common/src";

import {
  ATTRIBUTES_BY_NAME,
  ATTRIBUTES_BY_TYPE,
  type AttributeKey,
  type AttributePair,
  AttributeRepository,
  packXorAddress,
  type RawAttribute,
  unpackXorAddress,
} from "./attributes";
import {
  COOKIE,
  type classes,
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
  INTEGRITY_LENGTH,
  INTEGRITY_SHA256_MIN_VALUE_LENGTH,
  INTEGRITY_SHA256_VALUE_LENGTH,
  isStunMessage,
  type MessageIntegrityAlgorithm,
  type MessageIntegrityMode,
  type methods,
} from "./const";

/** HMAC-SHA1 length of MESSAGE-INTEGRITY (RFC 8489 §14.5). */
const INTEGRITY_SHA1_VALUE_LENGTH = INTEGRITY_LENGTH - 4;

/**
 * Whether `length` is an allowed MESSAGE-INTEGRITY-SHA256 value length:
 * 16 to 32 bytes in steps of 4 (RFC 8489 §14.6).
 */
export function isValidIntegritySha256Length(length: number) {
  return (
    Number.isInteger(length) &&
    length >= INTEGRITY_SHA256_MIN_VALUE_LENGTH &&
    length <= INTEGRITY_SHA256_VALUE_LENGTH &&
    length % 4 === 0
  );
}

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
  const alternateServers: unknown[] = [];
  // When integrityKey is provided, MESSAGE-INTEGRITY or
  // MESSAGE-INTEGRITY-SHA256 must be present and valid (RFC 8489 short-term
  // credentials / RFC 7675 authenticated consent responses). Both are checked
  // where they appear and decided after the loop: with both present only
  // MESSAGE-INTEGRITY-SHA256 counts (RFC 8489 §9.1.4).
  let integrityValid: boolean | undefined;
  let integritySha256Valid: boolean | undefined;
  let sawIntegrity = false;
  let sawIntegritySha256 = false;

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

    // RFC 8489 §14.5/§14.6: attributes after MESSAGE-INTEGRITY are not covered
    // by the HMAC and must be ignored, except MESSAGE-INTEGRITY-SHA256 and
    // FINGERPRINT (after MESSAGE-INTEGRITY-SHA256 only FINGERPRINT).
    const attrNameOnWire = ATTRIBUTES_BY_TYPE[attrType]?.[1];
    if (
      (sawIntegritySha256 && attrNameOnWire !== "FINGERPRINT") ||
      (sawIntegrity &&
        attrNameOnWire !== "FINGERPRINT" &&
        attrNameOnWire !== "MESSAGE-INTEGRITY-SHA256")
    ) {
      pos = valueEnd + padLen;
      continue;
    }
    if (attrNameOnWire === "MESSAGE-INTEGRITY") sawIntegrity = true;
    if (attrNameOnWire === "MESSAGE-INTEGRITY-SHA256")
      sawIntegritySha256 = true;

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
      if (attrName === "ALTERNATE-SERVER") {
        // Repeatable (RFC 8489 §14.15, e.g. one per address family); the
        // repository only keeps the last one.
        alternateServers.push(value);
      }

      if (attrName === "FINGERPRINT") {
        const fingerprint = messageFingerprint(data.slice(0, pos));
        if (
          attributeRepository.getAttributeValue("FINGERPRINT") !== fingerprint
        ) {
          return undefined;
        }
      } else if (attrName === "MESSAGE-INTEGRITY" && integrityKey) {
        integrityValid = integrityMatches(
          payload,
          computeIntegrity(
            data.slice(0, pos),
            integrityKey,
            "sha1",
            INTEGRITY_SHA1_VALUE_LENGTH,
          ),
        );
      } else if (attrName === "MESSAGE-INTEGRITY-SHA256" && integrityKey) {
        // A truncation outside 16..32 / not a multiple of 4 is malformed
        // (RFC 8489 §14.6).
        if (!isValidIntegritySha256Length(attrLen)) {
          return undefined;
        }
        integritySha256Valid = integrityMatches(
          payload,
          computeIntegrity(data.slice(0, pos), integrityKey, "sha256", attrLen),
        );
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

  // Reject unsigned or forged messages when the caller required
  // authentication. MESSAGE-INTEGRITY-SHA256 takes precedence: a message
  // carrying both is verified with it alone (RFC 8489 §9.1.4).
  if (integrityKey) {
    const verified = sawIntegritySha256 ? integritySha256Valid : integrityValid;
    if (!verified) {
      return undefined;
    }
  }

  return new Message(
    (messageType & 0x3eef) as methods,
    (messageType & 0x0110) as classes,
    transactionId,
    attributeRepository.getAttributes(),
    rawAttributes,
    alternateServers as [string, number][],
  );
}

export class Message extends AttributeRepository {
  public messageMethod: methods;
  public messageClass: classes;
  public transactionId: Buffer;
  public rawAttributes: RawAttribute[];
  /** Every ALTERNATE-SERVER attribute, in wire order. */
  public alternateServers: [string, number][];

  constructor(
    messageMethod: methods,
    messageClass: classes,
    transactionId: Buffer = randomBytes(12),
    attributes: AttributePair[] = [],
    rawAttributes: RawAttribute[] = [],
    alternateServers: [string, number][] = [],
  ) {
    super(attributes);
    this.messageMethod = messageMethod;
    this.messageClass = messageClass;
    this.transactionId = transactionId;
    this.rawAttributes = rawAttributes;
    this.alternateServers = alternateServers;
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

  /**
   * Integrity attribute this message is signed with: MESSAGE-INTEGRITY-SHA256
   * when present (it takes precedence, RFC 8489 §9.1.4), otherwise
   * MESSAGE-INTEGRITY, otherwise undefined. A parsed message only keeps the
   * integrity attributes parseMessage accepted in their RFC 8489 positions.
   */
  get integrityAlgorithm(): MessageIntegrityAlgorithm | undefined {
    const keys = this.attributesKeys;
    if (keys.includes("MESSAGE-INTEGRITY-SHA256")) return "sha256";
    if (keys.includes("MESSAGE-INTEGRITY")) return "sha1";
    return undefined;
  }

  /** Add MESSAGE-INTEGRITY (HMAC-SHA1) over the current attributes. */
  addMessageIntegrity(key: Buffer) {
    // MESSAGE-INTEGRITY precedes MESSAGE-INTEGRITY-SHA256 (RFC 8489 §14.6).
    if (this.attributesKeys.includes("MESSAGE-INTEGRITY-SHA256")) {
      throw new Error(
        "MESSAGE-INTEGRITY must be added before MESSAGE-INTEGRITY-SHA256",
      );
    }
    this.setAttribute("MESSAGE-INTEGRITY", this.messageIntegrity(key));
    return this;
  }

  /** HMAC-SHA1 MESSAGE-INTEGRITY value for the current attributes. */
  messageIntegrity(key: Buffer) {
    return computeIntegrity(
      this.bytes,
      key,
      "sha1",
      INTEGRITY_SHA1_VALUE_LENGTH,
    );
  }

  /**
   * Add MESSAGE-INTEGRITY-SHA256 (HMAC-SHA256, RFC 8489 §14.6) over the
   * current attributes, including a preceding MESSAGE-INTEGRITY.
   * `length` truncates the HMAC: 16 to 32 bytes in steps of 4.
   */
  addMessageIntegritySha256(
    key: Buffer,
    length: number = INTEGRITY_SHA256_VALUE_LENGTH,
  ) {
    if (!isValidIntegritySha256Length(length)) {
      throw new RangeError(
        `MESSAGE-INTEGRITY-SHA256 length must be 16..32 in steps of 4: ${length}`,
      );
    }
    // Only FINGERPRINT may follow MESSAGE-INTEGRITY-SHA256 (RFC 8489 §14.6).
    if (this.attributesKeys.includes("FINGERPRINT")) {
      throw new Error(
        "MESSAGE-INTEGRITY-SHA256 must be added before FINGERPRINT",
      );
    }
    this.setAttribute(
      "MESSAGE-INTEGRITY-SHA256",
      computeIntegrity(this.bytes, key, "sha256", length),
    );
    return this;
  }

  /**
   * Sign with the short-term credential `key` using the integrity attributes
   * `mode` selects (`"sha1"` = MESSAGE-INTEGRITY, `"sha256"` =
   * MESSAGE-INTEGRITY-SHA256, `"both"` = both in RFC 8489 order). Chain
   * `addFingerprint()` afterwards.
   */
  addIntegrity(key: Buffer, mode: MessageIntegrityMode = "sha1") {
    if (mode === "sha1" || mode === "both") {
      this.addMessageIntegrity(key);
    }
    if (mode === "sha256" || mode === "both") {
      this.addMessageIntegritySha256(key);
    }
    return this;
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

/**
 * HMAC over `data` (the message up to the integrity attribute) with the
 * header length rewritten to end right after an integrity attribute of
 * `length` value bytes, truncated to `length` (RFC 8489 §14.5 / §14.6).
 */
function computeIntegrity(
  data: Buffer,
  key: Buffer,
  algorithm: MessageIntegrityAlgorithm,
  length: number,
) {
  const checkData = setBodyLength(
    data,
    data.length - HEADER_LENGTH + 4 + length + paddingLength(length),
  );
  return createHmac(algorithm, key)
    .update(checkData)
    .digest()
    .subarray(0, length);
}

/** Constant-time comparison of a received and a computed integrity value. */
function integrityMatches(received: Buffer, expected: Buffer) {
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export function paddingLength(length: number) {
  const rest = length % 4;
  return rest === 0 ? 0 : 4 - rest;
}
