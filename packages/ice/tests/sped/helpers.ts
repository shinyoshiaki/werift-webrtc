import { type Address, Event, crc32 } from "../../../common/src";
import { Candidate } from "../../src/candidate";
import {
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
} from "../../src/stun/const";
import { type Message, paddingLength } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";

/** Shared Arrange: host UDP protocol for SPED decorate / datagram tests. */
export class SpedProtocolMock implements Protocol {
  type = "mock";
  onRequestReceived: Event<[Message, Address, Buffer]> = new Event();
  onDataReceived: Event<[Buffer, Address?]> = new Event();
  localCandidate = new Candidate(
    "some-foundation",
    1,
    "udp",
    20,
    "1.2.3.4",
    1234,
    "host",
  );
  sentMessage?: Message;
  request = async () => null as any;
  sendStun = async (message: Message) => {
    this.sentMessage = message;
  };
  async connectionMade() {}
  async sendData(_data: Buffer, _addr?: Address) {}
  async close() {}
}

/** Shared Arrange: comprehension-optional STUN attribute on the wire. */
export function serializeStunRawAttribute(type: number, value: Buffer): Buffer {
  const padLen = paddingLength(value.length);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value, Buffer.alloc(padLen)]);
}

/** Shared Arrange: set the STUN header length to match the buffer. */
export function rewriteStunMessageLength(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  out.writeUInt16BE(out.length - HEADER_LENGTH, 2);
  return out;
}

/** Shared Arrange: append a valid FINGERPRINT covering `prefix`. */
export function appendStunFingerprint(prefix: Buffer): Buffer {
  const checkData = Buffer.from(prefix);
  checkData.writeUInt16BE(
    prefix.length - HEADER_LENGTH + FINGERPRINT_LENGTH,
    2,
  );
  const fingerprint = (crc32(checkData) ^ FINGERPRINT_XOR) >>> 0;
  const value = Buffer.alloc(4);
  value.writeUInt32BE(fingerprint, 0);
  return rewriteStunMessageLength(
    Buffer.concat([prefix, serializeStunRawAttribute(0x8028, value)]),
  );
}
