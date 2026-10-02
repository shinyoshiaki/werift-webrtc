import { type Address, Event, crc32 } from "../../../common/src";
import { CandidatePair, type Connection } from "../../src";
import { Candidate } from "../../src/candidate";
import {
  type SpedHandle,
  type SpedHooks,
  attachSpedToConnection,
} from "../../src/internal/sped";
import { DTLS_IN_STUN_DATA } from "../../src/sped/draft00/constants";
import {
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
  classes,
  methods,
} from "../../src/stun/const";
import { Message, paddingLength } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";
import { createTestConnection } from "../utils";

/** Shared Arrange: default SPED hooks for Connection attach tests. */
export function createSpedTestHooks(
  overrides: Partial<SpedHooks> = {},
): SpedHooks {
  return {
    inject: async () => {},
    onFallbackFlight: async () => {},
    setRetransmissionMode: () => {},
    updateRtt: () => {},
    resetRtt: () => {},
    setMtu: () => {},
    ...overrides,
  };
}

/** Shared Arrange: attach SPED with default hooks. */
export function attachTestSped(
  connection: Connection,
  overrides: Partial<SpedHooks> = {},
): SpedHandle {
  return attachSpedToConnection(connection, createSpedTestHooks(overrides));
}

/** Shared Arrange: deliver a real HMAC-checked Binding before DTLS exists. */
export function preparePrestartSpedBinding() {
  const connection = createTestConnection(true);
  const protocol = new SpedProtocolMock();
  const pair = spedPair(protocol, "host");
  connection.checkList.push(pair);
  const hello = Buffer.from([22, 0xfe, 0xfd, 0, 1]);
  const receive = async (
    password = connection.localPassword,
    withData = true,
  ) => {
    protocol.sentMessage = undefined;
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", `${connection.localUsername}:remote`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLED", 1n);
    if (withData) request.appendRawAttribute(DTLS_IN_STUN_DATA, hello);
    request.addMessageIntegrity(Buffer.from(password)).addFingerprint();
    await (
      connection as unknown as {
        handleBindingRequest(
          protocol: Protocol,
          request: Message,
          address: Address,
          bytes: Buffer,
        ): Promise<void>;
      }
    ).handleBindingRequest(protocol, request, pair.remoteAddr, request.bytes);
    return protocol.sentMessage as Message | undefined;
  };
  return { connection, protocol, pair, hello, receive };
}

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
