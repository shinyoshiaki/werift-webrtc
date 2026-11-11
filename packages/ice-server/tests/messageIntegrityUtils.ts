// Shared Arrange helpers for the MESSAGE-INTEGRITY / MESSAGE-INTEGRITY-SHA256
// tests (RFC 8489 §14.5 / §14.6). Wire bytes built here use node:crypto
// directly, independent of Message, so the tests also cross-check it.
import { createHmac } from "crypto";

import { crc32 } from "../../common/src";
import {
  classes,
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
  methods,
} from "../src/stun/const";
import { Message } from "../src/stun/message";

export const MESSAGE_INTEGRITY = 0x0008;
export const MESSAGE_INTEGRITY_SHA256 = 0x001c;
export const SOFTWARE = 0x8022;
export const FINGERPRINT = 0x8028;

/** The short-term credential (ice-pwd) the messages are signed with. */
export const integrityKey = Buffer.from("remote-password", "utf8");
export const wrongIntegrityKey = Buffer.from("wrong-password", "utf8");

/** An unsigned Binding success response with an XOR-MAPPED-ADDRESS. */
export function bindingResponse() {
  return new Message(methods.BINDING, classes.RESPONSE).setAttribute(
    "XOR-MAPPED-ADDRESS",
    ["192.0.2.50", 5000],
  );
}

/** A Binding success response signed with `sign`. */
export function signedBindingResponse(sign: (message: Message) => Message) {
  return sign(bindingResponse()).bytes;
}

/** Wire bytes of one attribute (4 byte header, value padded to 4 bytes). */
export function attributeBytes(type: number, value: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([
    header,
    value,
    Buffer.alloc((4 - (value.length % 4)) % 4),
  ]);
}

/** `message` bytes with `attribute` appended and the header length updated. */
export function appendAttribute(message: Buffer, attribute: Buffer) {
  const bytes = Buffer.concat([message, attribute]);
  bytes.writeUInt16BE(bytes.length - HEADER_LENGTH, 2);
  return bytes;
}

/**
 * HMAC an integrity attribute of `length` value bytes appended to `message`
 * carries (header length rewritten to end after it), not truncated.
 */
export function integrityHmac(
  message: Buffer,
  algorithm: "sha1" | "sha256",
  key: Buffer,
  length: number,
) {
  const padded = length + ((4 - (length % 4)) % 4);
  const checkData = Buffer.from(message);
  checkData.writeUInt16BE(message.length - HEADER_LENGTH + 4 + padded, 2);
  return createHmac(algorithm, key).update(checkData).digest();
}

/**
 * `message` with a MESSAGE-INTEGRITY-SHA256 of `length` value bytes
 * appended: the HMAC-SHA256 truncated to `length`, or extended with zero
 * bytes past 32 (to build malformed lengths).
 */
export function appendIntegritySha256(
  message: Buffer,
  key: Buffer,
  length: number,
) {
  const hmac = integrityHmac(message, "sha256", key, length);
  const value = Buffer.concat([hmac, Buffer.alloc(Math.max(0, length - 32))]);
  return appendAttribute(
    message,
    attributeBytes(MESSAGE_INTEGRITY_SHA256, value.subarray(0, length)),
  );
}

/** Offset of the value of the first attribute of `type` in `message`. */
export function attributeValueOffset(message: Buffer, type: number) {
  for (let pos = HEADER_LENGTH; pos + 4 <= message.length; ) {
    const length = message.readUInt16BE(pos + 2);
    if (message.readUInt16BE(pos) === type) return pos + 4;
    pos += 4 + length + ((4 - (length % 4)) % 4);
  }
  throw new Error(`attribute ${type} not found`);
}

/** A copy of `message` with the first value byte of attribute `type` flipped. */
export function corruptAttribute(message: Buffer, type: number) {
  const bytes = Buffer.from(message);
  bytes[attributeValueOffset(bytes, type)] ^= 0xff;
  return bytes;
}

/** Attribute types of `message` in wire order. */
export function wireAttributeTypes(message: Buffer) {
  const types: number[] = [];
  for (let pos = HEADER_LENGTH; pos + 4 <= message.length; ) {
    const length = message.readUInt16BE(pos + 2);
    types.push(message.readUInt16BE(pos));
    pos += 4 + length + ((4 - (length % 4)) % 4);
  }
  return types;
}

/**
 * `message` with a FINGERPRINT over all of its bytes appended (including
 * attributes parseMessage ignores, which Message would not re-serialize).
 */
export function appendFingerprint(message: Buffer) {
  const checkData = Buffer.from(message);
  checkData.writeUInt16BE(
    message.length - HEADER_LENGTH + FINGERPRINT_LENGTH,
    2,
  );
  const value = Buffer.alloc(4);
  value.writeUInt32BE((crc32(checkData) ^ FINGERPRINT_XOR) >>> 0);
  return appendAttribute(message, attributeBytes(FINGERPRINT, value));
}
