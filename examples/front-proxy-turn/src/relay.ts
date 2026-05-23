import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import type { Duplex } from "node:stream";

import {
  type Message,
  classes,
  isChannelData,
  methods,
  parseMessage,
  splitTurnTcpFrames,
} from "../../../packages/ice-server/src";
import type { BackendTurnServer, RelaySink } from "./backendTurn";
import type { CredentialIssuer } from "./credentials";
import type { SharedFrontProxyKv } from "./kv";
import {
  type ClientTransportKey,
  type PublicTurnAddress,
  type RelayConnectionContext,
  computeClientTransportKey,
} from "./types";

type RandomSource = () => number;

export type FrontProxyRelayOptions = {
  id: string;
  kv: SharedFrontProxyKv;
  credentialIssuer: CredentialIssuer;
  backends: BackendTurnServer[];
  publicTurnAddress: PublicTurnAddress;
  random?: RandomSource;
};

type ActiveTurnConnection = {
  backend?: BackendTurnServer;
  buffer: Buffer;
  clientTransportKey: ClientTransportKey;
  sink: RelaySink;
};

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

export class FrontProxyRelay {
  private readonly httpServer = createHttpServer((request, response) => {
    void this.handleHttpRequest(request, response);
  });
  private readonly random: RandomSource;

  constructor(private readonly options: FrontProxyRelayOptions) {
    if (options.backends.length === 0) {
      throw new Error("FrontProxyRelay requires at least one backend");
    }
    this.random = options.random ?? Math.random;
  }

  get id() {
    return this.options.id;
  }

  acceptConnection(stream: Duplex, context: RelayConnectionContext) {
    const clientTransportKey = computeClientTransportKey(context);
    let turn: ActiveTurnConnection | undefined;

    const sink: RelaySink = {
      write: (data) =>
        new Promise<void>((resolve, reject) => {
          stream.write(data, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
      close: () => {
        stream.destroy();
      },
    };

    const detach = () => {
      stream.off("data", onData);
      if (turn?.backend) {
        turn.backend.detachRelay(clientTransportKey, sink);
      }
    };

    const onData = (chunk: Buffer) => {
      if (!turn && isHttpRequestChunk(chunk)) {
        detach();
        stream.unshift(chunk);
        this.httpServer.emit("connection", stream);
        return;
      }

      turn ??= {
        buffer: Buffer.alloc(0),
        clientTransportKey,
        sink,
      };

      void this.handleTurnChunk(turn, context, chunk).catch((error) => {
        stream.destroy(error);
      });
    };

    stream.on("data", onData);
    stream.once("close", detach);

    return {
      clientTransportKey,
      close: () => stream.destroy(),
      detach,
    };
  }

  async routeFrameForTest(
    frame: Buffer,
    context: RelayConnectionContext,
    sink: RelaySink = { write: () => {}, close: () => {} },
  ) {
    const clientTransportKey = computeClientTransportKey(context);
    const backend = this.resolveBackendForFrame(frame, clientTransportKey);
    backend.attachRelay(clientTransportKey, sink);
    await backend.handleFrame({ clientTransportKey, payload: frame }, context);
    return backend;
  }

  private async handleTurnChunk(
    turn: ActiveTurnConnection,
    context: RelayConnectionContext,
    chunk: Buffer,
  ) {
    turn.buffer = Buffer.concat([turn.buffer, chunk]);
    const { frames, malformed, rest } = splitTurnTcpFrames(turn.buffer);
    turn.buffer = Buffer.from(rest);

    if (malformed) {
      throw new RoutingError("malformed TURN/TCP frame");
    }

    for (const frame of frames) {
      const backend = this.resolveBackendForFrame(
        frame,
        turn.clientTransportKey,
      );
      if (backend !== turn.backend) {
        turn.backend?.detachRelay(turn.clientTransportKey, turn.sink);
        backend.attachRelay(turn.clientTransportKey, turn.sink);
        turn.backend = backend;
      }
      await backend.handleFrame(
        {
          clientTransportKey: turn.clientTransportKey,
          payload: frame,
        },
        context,
      );
    }
  }

  resolveBackendForFrame(frame: Buffer, clientTransportKey: string) {
    if (isChannelData(frame)) {
      return this.backendFromClientTransport(clientTransportKey);
    }

    const message = parseMessage(frame);
    if (!message) {
      throw new RoutingError("TURN frame is not a STUN message");
    }

    if (
      message.messageClass === classes.INDICATION &&
      message.messageMethod === methods.SEND
    ) {
      return this.backendFromClientTransport(clientTransportKey);
    }

    if (message.messageClass !== classes.REQUEST) {
      return this.backendFromClientTransport(clientTransportKey);
    }

    if (message.messageMethod === methods.ALLOCATE) {
      return this.backendForAllocate(message, clientTransportKey);
    }

    if (requiresUsernameRoute(message.messageMethod)) {
      const username = readUsername(message);
      return this.backendFromUsername(username);
    }

    return this.backendFromClientTransport(clientTransportKey);
  }

  private backendForAllocate(message: Message, clientTransportKey: string) {
    const username = message.getAttributeValue("USERNAME");
    const existingBackendId =
      this.options.kv.getClientTransportBackend(clientTransportKey);
    if (existingBackendId) {
      if (username) {
        this.options.kv.setUsernameBackend(username, existingBackendId);
      }
      return this.backendById(existingBackendId);
    }

    if (username) {
      const backend = this.backendFromUsername(username);
      this.options.kv.setClientTransportBackend(clientTransportKey, backend.id);
      return backend;
    }

    const backend = this.chooseBackend();
    this.options.kv.setClientTransportBackend(clientTransportKey, backend.id);
    return backend;
  }

  private backendFromUsername(username: string) {
    const backendId =
      this.options.kv.getUsernameBackend(username) ??
      this.options.credentialIssuer.backendIdFromUsername(username);
    if (!backendId) {
      throw new RoutingError(`unknown TURN username: ${username}`);
    }
    this.options.kv.setUsernameBackend(username, backendId);
    return this.backendById(backendId);
  }

  private backendFromClientTransport(clientTransportKey: string) {
    const backendId =
      this.options.kv.getClientTransportBackend(clientTransportKey);
    if (!backendId) {
      throw new RoutingError(`unknown client transport: ${clientTransportKey}`);
    }
    return this.backendById(backendId);
  }

  private chooseBackend() {
    return this.options.backends[
      Math.floor(this.random() * this.options.backends.length)
    ];
  }

  private backendById(backendId: string) {
    const backend = this.options.backends.find(
      (candidate) => candidate.id === backendId,
    );
    if (!backend) {
      throw new RoutingError(`backend is not registered: ${backendId}`);
    }
    return backend;
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    try {
      if (request.method === "OPTIONS") {
        writeEmpty(response, 204);
        return;
      }

      const pathname = new URL(
        request.url ?? "/",
        "https://front-proxy-turn.local",
      ).pathname;

      if (request.method === "GET" && pathname === "/health") {
        writeJson(response, 200, {
          relayId: this.id,
          turnUrl: this.turnUrl(),
          kv: this.options.kv.snapshot(),
          backends: this.options.backends.map((backend) => backend.id),
        });
        return;
      }

      if (request.method === "POST" && pathname === "/credentials") {
        await drainRequest(request);
        const backend = this.chooseBackend();
        const credentials = this.options.credentialIssuer.issue(backend.id);
        writeJson(response, 200, {
          ...credentials,
          turnUrl: this.turnUrl(),
          iceServers: [
            {
              urls: this.turnUrl(),
              username: credentials.username,
              credential: credentials.password,
            },
          ],
        });
        return;
      }

      if (
        request.method === "GET" &&
        (pathname === "/" || pathname === "/index.html")
      ) {
        const body = browserDemoHtml(this.turnUrl());
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        });
        response.end(body);
        return;
      }

      writeJson(response, 404, { error: "not-found" });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : "unexpected-error",
      });
    }
  }

  private turnUrl() {
    const { ip, port } = this.options.publicTurnAddress;
    return `turns:${ip}:${port}?transport=tcp`;
  }
}

function readUsername(message: Message) {
  const username = message.getAttributeValue("USERNAME");
  if (!username) {
    throw new RoutingError("TURN request does not contain USERNAME");
  }
  return username;
}

function requiresUsernameRoute(method: methods) {
  return (
    method === methods.REFRESH ||
    method === methods.CREATE_PERMISSION ||
    method === methods.CHANNEL_BIND
  );
}

function isHttpRequestChunk(chunk: Buffer) {
  const prefix = chunk
    .subarray(0, Math.min(chunk.length, 16))
    .toString("ascii");
  return /^(GET |POST |PUT |PATCH |DELETE |OPTIONS |HEAD )/.test(prefix);
}

async function drainRequest(request: IncomingMessage) {
  for await (const _chunk of request) {
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeEmpty(response: ServerResponse, statusCode: number) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  response.end();
}

function browserDemoHtml(turnUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>werift front-proxy TURN/TLS</title>
    <style>
      body { font-family: sans-serif; max-width: 760px; margin: 3rem auto; line-height: 1.5; }
      button { font-size: 1rem; padding: .6rem 1rem; }
      pre { background: #111; color: #eee; padding: 1rem; overflow: auto; }
    </style>
  </head>
  <body>
    <h1>front-proxy TURN/TLS relay-only demo</h1>
    <p>This page is served from the same TLS address as <code>${turnUrl}</code>.</p>
    <button id="start">Start relay-only DataChannel</button>
    <pre id="log">idle</pre>
    <script>
      const log = (line) => {
        document.querySelector("#log").textContent += "\\n" + line;
      };
      document.querySelector("#start").onclick = async () => {
        document.querySelector("#log").textContent = "requesting credentials";
        const credentials = await fetch("/credentials", { method: "POST" }).then((r) => r.json());
        const config = { iceServers: credentials.iceServers, iceTransportPolicy: "relay" };
        const offerer = new RTCPeerConnection(config);
        const answerer = new RTCPeerConnection(config);
        const channel = offerer.createDataChannel("front-proxy-turn");
        answerer.ondatachannel = ({ channel }) => {
          channel.onmessage = (event) => channel.send("echo:" + event.data);
        };
        offerer.onicecandidate = ({ candidate }) => candidate && answerer.addIceCandidate(candidate);
        answerer.onicecandidate = ({ candidate }) => candidate && offerer.addIceCandidate(candidate);
        const opened = new Promise((resolve) => channel.onopen = resolve);
        const echoed = new Promise((resolve) => channel.onmessage = (event) => resolve(event.data));
        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription);
        await opened;
        log("data channel open via " + credentials.turnUrl);
        channel.send("hello");
        log(await echoed);
        offerer.close();
        answerer.close();
      };
    </script>
  </body>
</html>`;
}
