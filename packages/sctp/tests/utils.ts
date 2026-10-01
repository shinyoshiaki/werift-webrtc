import { readFileSync } from "fs";

import type { SCTP } from "../src";
import {
  CookieEchoChunk,
  InitAckChunk,
  InitChunk,
  parsePacket,
  serializePacket,
} from "../src/chunk";
import type { Transport } from "../src/transport";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

/**
 * Arrange: transport whose sends can be held open or made to fail, so tests
 * can interleave cancellation with an in-flight chunk.
 */
export function createControlledTransport() {
  const sent: Buffer[] = [];
  let hold: Promise<void> | undefined;
  let release = () => {};
  let failSends = false;
  const transport: Transport = {
    send: async (data: Buffer) => {
      if (failSends) throw new Error("transport rejected");
      sent.push(data);
      if (hold) await hold;
    },
    close: () => {},
  };
  return {
    transport,
    sent,
    /** Keep subsequent sends pending until `release()`. */
    holdSends: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      hold = undefined;
      release();
    },
    failSends: () => {
      failSends = true;
    },
    restoreSends: () => {
      failSends = false;
    },
  };
}

/** Arrange: deliver an INIT_ACK (with state cookie) to an initiator in COOKIE_WAIT. */
export async function receiveInitAck(sctp: SCTP) {
  const ack = new InitAckChunk();
  ack.initiateTag = 0x1234;
  ack.advertisedRwnd = 131072;
  ack.outboundStreams = 65535;
  ack.inboundStreams = 65535;
  ack.initialTsn = 1;
  ack.params.push([0x0007, Buffer.from("cookie")]);
  const packet = serializePacket(
    5001,
    5000,
    (sctp as unknown as { localVerificationTag: number }).localVerificationTag,
    ack,
  );
  await (
    sctp as unknown as { handleData: (data: Buffer) => Promise<void> }
  ).handleData(packet);
}

type SctpInternals = {
  localVerificationTag: number;
  handleData: (data: Buffer) => Promise<void>;
};

/**
 * Arrange: drive a responder through INIT so it issues a state cookie.
 * Returns the cookie from the INIT_ACK it sent.
 */
export async function receiveInitAndTakeCookie(
  sctp: SCTP,
  sent: Buffer[],
): Promise<Buffer> {
  const init = new InitChunk();
  init.initiateTag = 0x5678;
  init.advertisedRwnd = 131072;
  init.outboundStreams = 65535;
  init.inboundStreams = 65535;
  init.initialTsn = 1;
  await (sctp as unknown as SctpInternals).handleData(
    serializePacket(5001, 5000, 0, init),
  );
  const initAck = parsePacket(sent[sent.length - 1])[3][0] as InitAckChunk;
  return initAck.params.find(([type]) => type === 0x0007)![1];
}

/** Arrange: deliver a COOKIE_ECHO carrying `cookie` to a responder. */
export async function receiveCookieEcho(sctp: SCTP, cookie: Buffer) {
  const echo = new CookieEchoChunk();
  echo.body = cookie;
  const internals = sctp as unknown as SctpInternals;
  await internals.handleData(
    serializePacket(5001, 5000, internals.localVerificationTag, echo),
  );
}

/** Arrange: chunk types carried by the packets a transport has sent. */
export function sentChunkTypes(sent: Buffer[]) {
  return sent.map((packet) => parsePacket(packet)[3][0].type);
}
