import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  createServer as createTlsServer,
  type TLSSocket,
  type TlsOptions,
} from "node:tls";

type SessionState = "awaiting-answer" | "answer-applied" | "closed";
type ChannelState = "open" | "closed" | "connecting" | "closing";
type PeerConnectionState =
  | "closed"
  | "failed"
  | "disconnected"
  | "new"
  | "connecting"
  | "connected";

type EventSubscription = {
  unSubscribe(): void;
};

type EventLike<TValue> = {
  subscribe(callback: (value: TValue) => void): EventSubscription;
};

type DataChannelLike = {
  onMessage: EventLike<string | Buffer>;
  stateChanged: EventLike<ChannelState>;
  send(data: string | Buffer): void;
};

type PeerConnectionLike = {
  connectionState: PeerConnectionState;
  iceGatheringState: string;
  localDescription?: RTCSessionDescriptionInit;
  connectionStateChange: EventLike<PeerConnectionState>;
  iceGatheringStateChange: EventLike<string>;
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<unknown>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<unknown>;
  close(): void;
};

type NodeTurnServerLike = {
  attachTlsSocket(
    socket: TLSSocket,
    options?: {
      initialData?: Buffer;
    },
  ): void;
  close(): Promise<void>;
  listen(): Promise<void>;
};

type NodeTurnServerConstructor = new (options: {
  host: string;
  port: number;
  relayAddress: string;
  relayBindAddress: string;
  realm: string;
  software: string;
  fingerprint: "always";
  udp: boolean;
  tcp: boolean;
  tls: {
    external: true;
    port: number;
  };
  getPassword: (username: string) => string | undefined;
}) => NodeTurnServerLike;

type RTCPeerConnectionConstructor = new (
  configuration: Record<string, never>,
) => PeerConnectionLike;

const require = createRequire(import.meta.url);
const { NodeTurnServer } = require("../../../packages/ice-server/src") as {
  NodeTurnServer: NodeTurnServerConstructor;
};
const { RTCPeerConnection } = require("../../../packages/webrtc/src") as {
  RTCPeerConnection: RTCPeerConnectionConstructor;
};

type SessionRecord = {
  username: string;
  password: string;
  peer: PeerConnectionLike;
  channel: DataChannelLike;
  state: SessionState;
  timeout?: NodeJS.Timeout;
};

type SessionResponse = {
  offer: RTCSessionDescriptionInit;
  turnUrl: string;
  username: string;
  password: string;
};

type JsonRecord = Record<string, unknown>;

const host = process.env.TURN_LOOPBACK_HOST ?? "0.0.0.0";
const port = numberFromEnv("TURN_LOOPBACK_PORT", 8443);
const publicHost =
  process.env.TURN_LOOPBACK_PUBLIC_HOST ??
  (host === "0.0.0.0" ? "127.0.0.1" : host);
const relayAddress =
  process.env.TURN_LOOPBACK_RELAY_ADDRESS ??
  (host === "0.0.0.0" ? "127.0.0.1" : host);
const relayBindAddress = process.env.TURN_LOOPBACK_RELAY_BIND_ADDRESS ?? host;
const realm = process.env.TURN_LOOPBACK_REALM ?? "turn-loopback.local";
const pendingSessionTtlMs = numberFromEnv(
  "TURN_LOOPBACK_PENDING_SESSION_TTL_MS",
  60_000,
);
const activeSessionTtlMs = numberFromEnv(
  "TURN_LOOPBACK_ACTIVE_SESSION_TTL_MS",
  300_000,
);

const sessions = new Map<string, SessionRecord>();
const activeTlsSockets = new Set<TLSSocket>();

const turnServer = new NodeTurnServer({
  host,
  port: 0,
  relayAddress,
  relayBindAddress,
  realm,
  software: "werift-example-turn-loopback",
  fingerprint: "always",
  udp: false,
  tcp: false,
  tls: {
    external: true,
    port,
  },
  getPassword: (username: string) => sessions.get(username)?.password,
});

const httpServer = createHttpServer((request, response) => {
  void handleRequest(request, response);
});

const tlsServer = createTlsServer(readTlsOptions(), (socket) => {
  activeTlsSockets.add(socket);
  socket.on("close", () => {
    activeTlsSockets.delete(socket);
  });
  routeSecureSocket(socket);
});

tlsServer.on("tlsClientError", (error) => {
  console.error("tls client error", error);
});

process.once("SIGINT", () => {
  void shutdown(130);
});

process.once("SIGTERM", () => {
  void shutdown(143);
});

process.once("uncaughtException", (error) => {
  console.error(error);
  void shutdown(1);
});

process.once("unhandledRejection", (reason) => {
  console.error(reason);
  void shutdown(1);
});

let shuttingDown = false;

void main().catch((error) => {
  console.error(error);
  void shutdown(1);
});

async function main() {
  await turnServer.listen();
  await new Promise<void>((resolvePromise, reject) => {
    tlsServer.once("error", reject);
    tlsServer.listen(port, host, () => {
      tlsServer.off("error", reject);
      resolvePromise();
    });
  });

  console.log("turn-loopback server started", {
    host,
    port,
    publicHost,
    relayAddress,
    turnUrl: `turns:${publicHost}:${port}?transport=tcp`,
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    if (request.method === "OPTIONS") {
      writeEmpty(response, 204);
      return;
    }

    if (request.url === "/health" && request.method === "GET") {
      writeJson(response, 200, {
        sessions: sessions.size,
        turnUrl: `turns:${publicHost}:${port}?transport=tcp`,
      });
      return;
    }

    if (request.url === "/session" && request.method === "POST") {
      const session = await createSession();
      writeJson(response, 200, session);
      return;
    }

    if (request.url === "/session" && request.method === "PUT") {
      const body = await readJsonBody(request);
      await applyAnswer(body);
      writeEmpty(response, 204);
      return;
    }

    writeJson(response, 404, { error: "not-found" });
  } catch (error) {
    console.error("request failed", error);
    const statusCode = statusCodeFromError(error);
    writeJson(response, statusCode, {
      error: error instanceof Error ? error.message : "unexpected-error",
    });
  }
}

async function createSession(): Promise<SessionResponse> {
  const username = `turn-loopback-${randomUUID()}`;
  const password = randomBytes(18).toString("base64url");
  const peer = new RTCPeerConnection({});
  const channel = peer.createDataChannel("loopback");
  const session: SessionRecord = {
    username,
    password,
    peer,
    channel,
    state: "awaiting-answer",
  };

  sessions.set(username, session);
  wireSessionLifecycle(session);

  try {
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceGatheringComplete(peer);
    if (!peer.localDescription) {
      throw new Error("offer was not created");
    }

    return {
      offer: peer.localDescription,
      turnUrl: `turns:${publicHost}:${port}?transport=tcp`,
      username,
      password,
    };
  } catch (error) {
    closeSession(username, "session setup failed");
    throw error;
  }
}

async function applyAnswer(body: JsonRecord) {
  const username = readString(body.username, "username");
  const answer = readSessionDescription(body.answer, "answer");
  const session = sessions.get(username);
  if (!session) {
    throw createHttpError(404, `session not found: ${username}`);
  }
  if (session.state !== "awaiting-answer") {
    throw createHttpError(409, `session is not waiting for an answer: ${username}`);
  }

  await session.peer.setRemoteDescription(answer);
  session.state = "answer-applied";
  scheduleSessionTimeout(session, activeSessionTtlMs, "active session timeout");
}

function wireSessionLifecycle(session: SessionRecord) {
  scheduleSessionTimeout(
    session,
    pendingSessionTtlMs,
    "answer timeout waiting for PUT /session",
  );

  session.channel.onMessage.subscribe((message: string | Buffer) => {
    scheduleSessionTimeout(session, activeSessionTtlMs, "idle data channel timeout");
    session.channel.send(message);
  });

  session.channel.stateChanged.subscribe((state: ChannelState) => {
    if (state === "open") {
      scheduleSessionTimeout(
        session,
        activeSessionTtlMs,
        "open data channel timeout",
      );
      return;
    }
    if (state === "closed") {
      closeSession(session.username, "data channel closed");
    }
  });

  session.peer.connectionStateChange.subscribe((state: PeerConnectionState) => {
    if (state === "connected") {
      scheduleSessionTimeout(session, activeSessionTtlMs, "connected peer timeout");
      return;
    }
    if (state === "closed" || state === "failed") {
      closeSession(session.username, `peer connection ${state}`);
    }
  });
}

function closeSession(username: string, reason: string) {
  const session = sessions.get(username);
  if (!session || session.state === "closed") {
    return;
  }

  sessions.delete(username);
  session.state = "closed";
  if (session.timeout) {
    clearTimeout(session.timeout);
    session.timeout = undefined;
  }
  if (session.peer.connectionState !== "closed") {
    session.peer.close();
  }

  console.log("closed session", { username, reason });
}

function scheduleSessionTimeout(
  session: SessionRecord,
  timeoutMs: number,
  reason: string,
) {
  if (session.timeout) {
    clearTimeout(session.timeout);
  }

  session.timeout = setTimeout(() => {
    closeSession(session.username, reason);
  }, timeoutMs);
}

function routeSecureSocket(socket: TLSSocket) {
  socket.once("data", (firstChunk) => {
    socket.pause();
    if (isHttpRequestChunk(firstChunk)) {
      socket.unshift(firstChunk);
      httpServer.emit("connection", socket);
    } else {
      turnServer.attachTlsSocket(socket, { initialData: firstChunk });
    }
    socket.resume();
  });
}

function isHttpRequestChunk(chunk: Buffer) {
  const prefix = chunk.subarray(0, Math.min(chunk.length, 16)).toString("ascii");
  return /^(GET |POST |PUT |PATCH |DELETE |OPTIONS |HEAD )/.test(prefix);
}

async function waitForIceGatheringComplete(peer: PeerConnectionLike) {
  if (peer.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      subscription.unSubscribe();
      reject(new Error("ICE gathering did not complete in time"));
    }, 15_000);
    const subscription = peer.iceGatheringStateChange.subscribe((state: string) => {
      if (state !== "complete") {
        return;
      }
      clearTimeout(timer);
      subscription.unSubscribe();
      resolvePromise();
    });
  });
}

function readTlsOptions(): TlsOptions {
  return {
    cert: readPem(
      "TURN_LOOPBACK_CERT_PEM",
      "TURN_LOOPBACK_CERT_FILE",
      "cert.pem",
    ),
    key: readPem("TURN_LOOPBACK_KEY_PEM", "TURN_LOOPBACK_KEY_FILE", "key.pem"),
  };
}

function readPem(
  pemEnvName: string,
  fileEnvName: string,
  defaultAssetName: string,
) {
  const inlinePem = process.env[pemEnvName];
  if (inlinePem) {
    return inlinePem;
  }

  const pemFile = process.env[fileEnvName];
  if (pemFile) {
    return readFileSync(resolve(process.cwd(), pemFile));
  }

  return readFileSync(
    resolve(process.cwd(), "../../packages/dtls/assets", defaultAssetName),
  );
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createHttpError(400, "request body must be a JSON object");
  }

  return parsed as JsonRecord;
}

function readString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw createHttpError(400, `${fieldName} must be a non-empty string`);
  }
  return value;
}

function readSessionDescription(
  value: unknown,
  fieldName: string,
): RTCSessionDescriptionInit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createHttpError(400, `${fieldName} must be a session description object`);
  }

  const type = (value as RTCSessionDescriptionInit).type;
  const sdp = (value as RTCSessionDescriptionInit).sdp;
  if (typeof type !== "string" || typeof sdp !== "string") {
    throw createHttpError(400, `${fieldName} must contain type and sdp`);
  }

  return { type, sdp };
}

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function createHttpError(statusCode: number, message: string) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function statusCodeFromError(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }
  return 500;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeEmpty(response: ServerResponse, statusCode: number) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  });
  response.end();
}

async function shutdown(exitCode: number) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const socket of activeTlsSockets) {
    socket.destroy();
  }
  activeTlsSockets.clear();

  for (const username of [...sessions.keys()]) {
    closeSession(username, "process shutdown");
  }

  await turnServer.close();
  await new Promise<void>((resolvePromise) => {
    tlsServer.close(() => resolvePromise());
  });
  process.exit(exitCode);
}
