import * as dgram from "node:dgram";
import type { Address } from "../../../common/src";
import { Candidate } from "../../src/candidate";
import type { IceCandidateErrorInfo } from "../../src/candidateError";
import type { Connection } from "../../src/ice";
import type { IceOptions } from "../../src/iceBase";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";
import { getHostAddresses } from "../../src/utils";
import { createTestConnection } from "../utils";

/**
 * Shared Arrange for the `onIceCandidateError` tests (candidate-error.test.ts).
 */

/** First IPv4 host address of the machine. */
export const candidateErrorHost = getHostAddresses(true, false)[0]!;

/** One IPv4 UDP host socket, so every STUN query comes from one base. */
export const singleIpv4Socket = {
  useIpv6: false,
  interfaceAddresses: { udp4: candidateErrorHost },
} as const;

/** Every `onIceCandidateError` of `connection`, in order. */
export function recordCandidateErrors(connection: Connection) {
  const errors: IceCandidateErrorInfo[] = [];
  connection.onIceCandidateError.subscribe((info) => errors.push(info));
  return errors;
}

/** An agent with one IPv4 UDP host socket and `options`, recording its errors. */
export function createRecordingAgent(options: Partial<IceOptions> = {}) {
  const connection = createTestConnection(true, {
    ...singleIpv4Socket,
    ...options,
  });
  return { connection, errors: recordCandidateErrors(connection) };
}

/**
 * A UDP server that answers every request with `reply(request)` after
 * `delayMs` (nothing for undefined). Requests are recorded.
 */
export async function createScriptedUdpServer(
  reply: (request: Message) => Buffer | undefined,
  { host = candidateErrorHost, delayMs = 0 } = {},
) {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, host, () => resolve()));
  const requests: Message[] = [];
  socket.on("message", (data, remote) => {
    const request = parseMessage(data);
    if (!request || request.messageClass !== classes.REQUEST) return;
    requests.push(request);
    const bytes = reply(request);
    if (!bytes) return;
    setTimeout(() => {
      try {
        socket.send(bytes, remote.port, remote.address);
      } catch {
        // closed meanwhile
      }
    }, delayMs);
  });
  return {
    address: [host, socket.address().port] as Address,
    requests,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/** Wire bytes of an error response to `request` with `code` and `reason`. */
export function errorResponse(
  request: Message,
  code: number,
  reason: string,
  attributes: [string, unknown][] = [],
) {
  const response = new Message(
    request.messageMethod,
    classes.ERROR,
    request.transactionId,
  ).setAttribute("ERROR-CODE", [code, reason]);
  for (const [key, value] of attributes) {
    response.setAttribute(key as never, value);
  }
  return response.bytes;
}

/** A STUN server answering every Binding request with the error `code`. */
export function createErrorStunServer(code: number, reason: string) {
  return createScriptedUdpServer((request) =>
    errorResponse(request, code, reason),
  );
}

/** A STUN server answering Binding success responses without XOR-MAPPED-ADDRESS. */
export function createNoMappingStunServer() {
  return createScriptedUdpServer(
    (request) =>
      new Message(methods.BINDING, classes.RESPONSE, request.transactionId)
        .bytes,
  );
}

/**
 * A UDP-only TURN server rejecting every Allocate with an unsigned 401 and a
 * realm / nonce (a credential it never accepts). Nothing listens on TCP at
 * its port, so the TCP fallback is refused.
 */
export function createRejectingUdpTurnServer() {
  return createScriptedUdpServer((request) =>
    errorResponse(request, 401, "Unauthorized", [
      ["REALM", "werift.test"],
      ["NONCE", Buffer.from("nonce-1")],
    ]),
  );
}

/** A host candidate of the test address and `port`. */
export function hostCandidate(port = 50000) {
  return new Candidate("1", 1, "udp", 1, candidateErrorHost, port, "host");
}

/**
 * A Protocol whose STUN requests are answered by `request` (no network);
 * `localCandidate` is a host candidate unless `withLocalCandidate` is false.
 */
export function createFakeStunProtocol(
  request: (message: Message, addr: Address) => Promise<[Message, Address]>,
  { withLocalCandidate = true } = {},
) {
  const sent: Message[] = [];
  const protocol = {
    type: "fake",
    localCandidate: withLocalCandidate ? hostCandidate() : undefined,
    request: async (message: Message, addr: Address) => {
      sent.push(message);
      return request(message, addr);
    },
  } as unknown as Protocol;
  return { protocol, sent };
}

/** An errno error as Node's socket / DNS functions raise it. */
export function errnoError(code: string) {
  return Object.assign(new Error(`${code} test`), { code });
}
