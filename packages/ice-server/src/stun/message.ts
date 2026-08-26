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

/**
 * One STUN attribute in on-wire order (known or comprehension-optional raw).
 * RFC 8489 HMAC covers attributes that precede MESSAGE-INTEGRITY, so unknown
 * optional attributes must sit in this list before integrity — not in a trailing dump.
 * File-private: not part of the ice-server / ice public API.
 */
type WireAttribute =
  | {
      kind: "known";
      name: AttributeKey;
      value: unknown;
    }
  | {
      kind: "raw";
      type: number;
      value: Buffer;
    };

const messageWireAttributes = new WeakMap<Message, WireAttribute[]>();
const messageRawAttributes = new WeakMap<Message, RawAttribute[]>();

function wireAttributesOf(message: Message): WireAttribute[] {
  const existing = messageWireAttributes.get(message);
  if (existing) {
    return existing;
  }
  const created: WireAttribute[] = [];
  messageWireAttributes.set(message, created);
  return created;
}

function setMessageWireAttributes(
  message: Message,
  wireAttributes: WireAttribute[],
) {
  messageWireAttributes.set(message, wireAttributes);
}

function rawAttributeListOf(message: Message): RawAttribute[] {
  const existing = messageRawAttributes.get(message);
  if (existing) {
    return existing;
  }
  const created: RawAttribute[] = [];
  messageRawAttributes.set(message, created);
  return created;
}

function setRawAttributeList(message: Message, list: RawAttribute[]) {
  messageRawAttributes.set(message, list);
}

/** Point the live rawAttributes array at the current wire raw buffers. */
function bindRawAttributesFromWire(message: Message) {
  const list: RawAttribute[] = [];
  for (const attribute of wireAttributesOf(message)) {
    if (attribute.kind === "raw") {
      list.push({
        type: attribute.type,
        value: attribute.value,
        length: attribute.value.length,
      });
    }
  }
  setRawAttributeList(message, list);
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
  const wireAttributes: WireAttribute[] = [];
  // When integrityKey is provided, MESSAGE-INTEGRITY must be present and valid
  // (RFC 5389 short-term credentials / RFC 7675 authenticated consent responses).
  // Attributes after MESSAGE-INTEGRITY are not HMAC-covered (FINGERPRINT may
  // follow); SPED DATA/ACK in that region must not be published.
  let messageIntegrityVerified = false;

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
    // RFC 8489 §9: ignore every attribute after MESSAGE-INTEGRITY except
    // MESSAGE-INTEGRITY-SHA256 and FINGERPRINT. Do not unpack ignored
    // attributes; a malformed trailing attribute must not fail the message.
    if (integrityKey && messageIntegrityVerified) {
      const attrName = attribute?.[1];
      if (
        attrName !== "FINGERPRINT" &&
        attrName !== "MESSAGE-INTEGRITY-SHA256"
      ) {
        pos = valueEnd + padLen;
        continue;
      }
    }

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
      wireAttributes.push({
        kind: "known",
        name: attrName as AttributeKey,
        value,
      });

      if (attrName === "FINGERPRINT") {
        const fingerprint = messageFingerprint(data.slice(0, pos));
        if (value !== fingerprint) {
          return undefined;
        }
      } else if (attrName === "MESSAGE-INTEGRITY" && integrityKey) {
        const integrity = messageIntegrity(data.slice(0, pos), integrityKey);
        if (!Buffer.isBuffer(value) || !integrity.equals(value)) {
          return undefined;
        }
        messageIntegrityVerified = true;
      }
    } else {
      wireAttributes.push({
        kind: "raw",
        type: attrType,
        value: Buffer.from(payload),
      });
    }

    pos = valueEnd + padLen;
  }

  // Reject unsigned messages when the caller required authentication.
  if (integrityKey && !messageIntegrityVerified) {
    return undefined;
  }

  const message = new Message(
    messageType & 0x3eef,
    messageType & 0x0110,
    transactionId,
    attributeRepository.getAttributes(),
  );
  setMessageWireAttributes(message, wireAttributes);
  bindRawAttributesFromWire(message);
  return message;
}

export class Message extends AttributeRepository {
  constructor(
    public messageMethod: methods,
    public messageClass: classes,
    public transactionId: Buffer = randomBytes(12),
    attributes: AttributePair[] = [],
    rawAttributes: RawAttribute[] = [],
  ) {
    super(attributes);
    setRawAttributeList(this, rawAttributes);
    setMessageWireAttributes(this, [
      ...attributes.map(
        ([name, value]): WireAttribute => ({
          kind: "known",
          name,
          value,
        }),
      ),
      ...rawAttributes.map(
        (attribute): WireAttribute => ({
          kind: "raw",
          type: attribute.type,
          value: attribute.value,
        }),
      ),
    ]);
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

  /**
   * Unknown (not in ATTRIBUTES) attributes in wire order.
   * Live array: `push` / in-place edits are serialized (develop-compatible).
   */
  get rawAttributes(): RawAttribute[] {
    return rawAttributeListOf(this);
  }

  set rawAttributes(value: RawAttribute[]) {
    setRawAttributeList(this, value);
    this.reconcileWireFromPublicArrays();
  }

  appendRawAttribute(type: number, value: Buffer) {
    const copied = Buffer.from(value);
    rawAttributeListOf(this).push({
      type,
      value: copied,
      length: copied.length,
    });
    const raw: WireAttribute = {
      kind: "raw",
      type,
      value: copied,
    };
    const wire = wireAttributesOf(this);
    const insertAt = integrityBoundaryIndex(wire);
    wire.splice(insertAt, 0, raw);
    return this;
  }

  get unknownAttributeTypes() {
    return this.rawAttributes.map((attribute) => attribute.type);
  }

  override setAttribute(key: AttributeKey, value: any) {
    const wire = wireAttributesOf(this);
    const existing = wire.find(
      (attribute) => attribute.kind === "known" && attribute.name === key,
    );
    if (existing && existing.kind === "known") {
      existing.value = value;
    } else {
      wire.push({ kind: "known", name: key, value });
    }
    return super.setAttribute(key, value);
  }

  override clear() {
    setRawAttributeList(this, []);
    setMessageWireAttributes(this, []);
    super.clear();
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
    this.reconcileWireFromPublicArrays();
    return wireAttributesOf(this).map((attribute) => {
      if (attribute.kind === "raw") {
        return { type: attribute.type, value: Buffer.from(attribute.value) };
      }
      const [attrType, , attrPack] = ATTRIBUTES_BY_NAME[attribute.name];
      const value =
        attrPack.name === packXorAddress.name
          ? attrPack(attribute.value, this.transactionId)
          : attrPack(attribute.value);
      return { type: attrType, value };
    });
  }

  /**
   * Public `attributes` / `rawAttributes` arrays are the membership source;
   * wire order is preserved for entries that still exist in those arrays.
   */
  private reconcileWireFromPublicArrays() {
    const wire = wireAttributesOf(this);
    const rawList = rawAttributeListOf(this);
    const remainingKnown = new Map<AttributeKey, unknown>();
    for (const [name, value] of this.attributes) {
      if (!remainingKnown.has(name)) {
        remainingKnown.set(name, value);
      }
    }

    const kept: WireAttribute[] = [];
    const consumedRaw = new Set<RawAttribute>();
    for (const attribute of wire) {
      if (attribute.kind === "known") {
        if (!remainingKnown.has(attribute.name)) {
          continue;
        }
        attribute.value = remainingKnown.get(attribute.name);
        remainingKnown.delete(attribute.name);
        kept.push(attribute);
        continue;
      }
      const match = rawList.find(
        (raw) =>
          !consumedRaw.has(raw) &&
          raw.type === attribute.type &&
          raw.value === attribute.value,
      );
      if (!match) {
        continue;
      }
      consumedRaw.add(match);
      kept.push(attribute);
    }

    for (const [name, value] of remainingKnown) {
      kept.splice(integrityBoundaryIndex(kept), 0, {
        kind: "known",
        name,
        value,
      });
    }
    for (const raw of rawList) {
      if (consumedRaw.has(raw)) {
        continue;
      }
      kept.splice(integrityBoundaryIndex(kept), 0, {
        kind: "raw",
        type: raw.type,
        value: raw.value,
      });
    }

    setMessageWireAttributes(this, kept);
  }
}

/** Insert raw attributes before MESSAGE-INTEGRITY / FINGERPRINT when present. */
function integrityBoundaryIndex(wire: WireAttribute[]): number {
  const index = wire.findIndex(
    (attribute) =>
      attribute.kind === "known" &&
      (attribute.name === "MESSAGE-INTEGRITY" ||
        attribute.name === "MESSAGE-INTEGRITY-SHA256" ||
        attribute.name === "FINGERPRINT"),
  );
  return index < 0 ? wire.length : index;
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
