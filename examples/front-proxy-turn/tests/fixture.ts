import { type TLSSocket, connect as connectTls } from "node:tls";

import type { Address } from "../../../packages/common/src";
import {
  Message,
  classes,
  encodeChannelData,
  makeTurnIntegrityKey,
  methods,
  padTurnFrame,
  parseMessage,
  splitTurnTcpFrames,
} from "../../../packages/ice-server/src";
import { BackendTurnServer } from "../src/backendTurn";
import { CredentialIssuer, type TurnCredentials } from "../src/credentials";
import { SharedFrontProxyKv } from "../src/kv";
import { FrontProxyRelay } from "../src/relay";
import type { RelayConnectionContext } from "../src/types";

export const TURN_REALM = "front-proxy-turn.test";
export const UDP_TRANSPORT = 0x11000000;

export function createContext(
  clientPort = 53124,
  publicPort = 443,
): RelayConnectionContext {
  return {
    originalClientAddress: {
      ip: "203.0.113.10",
      port: clientPort,
    },
    publicTurnAddress: {
      ip: "34.120.1.10",
      port: publicPort,
      transport: "tcp",
    },
  };
}

export function createBackend(id: string, issuer: CredentialIssuer) {
  return new BackendTurnServer({
    id,
    realm: TURN_REALM,
    relayAddress: "127.0.0.1",
    relayBindAddress: "127.0.0.1",
    fingerprint: "always",
    getPassword: (username) => issuer.passwordForUsername(username),
  });
}

export function createRelayHarness(random = () => 0) {
  const kv = new SharedFrontProxyKv();
  const issuer = new CredentialIssuer("front-proxy-turn-test-secret", kv);
  const backends = [
    createBackend("backend-1", issuer),
    createBackend("backend-2", issuer),
  ];
  const relay = new FrontProxyRelay({
    id: "relay-1",
    kv,
    credentialIssuer: issuer,
    backends,
    publicTurnAddress: createContext().publicTurnAddress,
    random,
  });
  return { kv, issuer, backends, relay };
}

export class RecordingSink {
  readonly chunks: Buffer[] = [];
  closed = false;

  write(data: Buffer) {
    this.chunks.push(Buffer.from(data));
  }

  close() {
    this.closed = true;
  }
}

export function makeAllocateRequest() {
  return new Message(methods.ALLOCATE, classes.REQUEST).setAttribute(
    "REQUESTED-TRANSPORT",
    UDP_TRANSPORT,
  );
}

export function requestWithUsername(method: methods, username: string) {
  return new Message(method, classes.REQUEST).setAttribute(
    "USERNAME",
    username,
  );
}

export function sendIndication() {
  return new Message(methods.SEND, classes.INDICATION)
    .setAttribute("XOR-PEER-ADDRESS", ["127.0.0.1", 5000] as Address)
    .setAttribute("DATA", Buffer.from("hello"));
}

export function channelData() {
  return encodeChannelData(0x4000, Buffer.from("hello"));
}

export function authenticateTurnRequest(
  request: Message,
  nonce: Buffer,
  credentials: TurnCredentials,
) {
  return request
    .setAttribute("USERNAME", credentials.username)
    .setAttribute("REALM", TURN_REALM)
    .setAttribute("NONCE", nonce)
    .addMessageIntegrity(
      makeTurnIntegrityKey(
        credentials.username,
        TURN_REALM,
        credentials.password,
      ),
    )
    .addFingerprint();
}

export function readFirstTurnMessage(sink: RecordingSink) {
  const [message] = readTurnMessages(sink.chunks);
  if (!message) {
    throw new Error("expected a TURN response");
  }
  return message;
}

export function readTurnMessages(chunks: Buffer[]) {
  if (chunks.length === 0) {
    throw new Error("expected a TURN response");
  }
  const { frames } = splitTurnTcpFrames(Buffer.concat(chunks));
  if (frames.length === 0) {
    throw new Error("expected a complete TURN frame");
  }
  return frames.map((frame) => {
    const message = parseMessage(frame);
    if (!message) {
      throw new Error("expected a STUN message");
    }
    return message;
  });
}

export async function connectTurnTls(port: number) {
  const socket = connectTls({
    host: "127.0.0.1",
    port,
    rejectUnauthorized: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return socket;
}

export function createTurnTcpReader(socket: TLSSocket) {
  let buffer = Buffer.alloc(0);
  const pending: ((frame: Buffer) => void)[] = [];
  const frames: Buffer[] = [];

  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    const parsed = splitTurnTcpFrames(buffer);
    buffer = Buffer.from(parsed.rest);
    frames.push(...parsed.frames);

    while (pending.length > 0 && frames.length > 0) {
      pending.shift()?.(frames.shift()!);
    }
  });

  return () =>
    new Promise<Buffer>((resolve) => {
      if (frames.length > 0) {
        resolve(frames.shift()!);
        return;
      }
      pending.push(resolve);
    });
}

export function writeTurnFrame(socket: TLSSocket, frame: Buffer) {
  socket.write(padTurnFrame(frame));
}
