import { type Address, Event, crc32 } from "../../../common/src";
import { CandidatePair } from "../../src";
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
  request: Protocol["request"] = async () => null as any;
  sendStun = async (message: Message) => {
    this.sentMessage = message;
  };
  async connectionMade() {}
  async sendData(_data: Buffer, _addr?: Address) {}
  async close() {}
}

/** Shared Arrange: host/srflx/relay remote pair on a local protocol. */
export function spedPair(
  protocol: Protocol,
  remoteType: string,
  remoteHost = "9.9.9.9",
  remotePort = 9,
) {
  return new CandidatePair(
    protocol,
    new Candidate("remote", 1, "udp", 1, remoteHost, remotePort, remoteType),
    true,
  );
}

/** Shared Arrange: host TCP ICE pair (active or passive). */
export function tcpSpedPair(options: {
  localType: "active" | "passive";
  remoteType: "active" | "passive";
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
}) {
  const protocol = new SpedProtocolMock();
  protocol.localCandidate = new Candidate(
    `tcp-${options.localType}`,
    1,
    "tcp",
    20,
    options.localHost ?? "192.0.2.1",
    options.localPort ?? (options.localType === "active" ? 9 : 5000),
    "host",
    undefined,
    undefined,
    options.localType,
  );
  return new CandidatePair(
    protocol,
    new Candidate(
      `tcp-remote-${options.remoteType}`,
      1,
      "tcp",
      1,
      options.remoteHost ?? "192.0.2.2",
      options.remotePort ?? (options.remoteType === "passive" ? 5000 : 40000),
      "host",
      undefined,
      undefined,
      options.remoteType,
    ),
    true,
  );
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
