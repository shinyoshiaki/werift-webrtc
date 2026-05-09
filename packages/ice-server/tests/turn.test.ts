import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { type Socket as TcpSocket, connect } from "node:net";
import { type TLSSocket, connect as connectTls } from "node:tls";

import { describe, expect, test, vi } from "vitest";

import type { Address } from "../../common/src";
import {
  Message,
  NodeTurnServer,
  type TurnServerAction,
  TurnServerProtocol,
  classes,
  decodeChannelData,
  encodeChannelData,
  makeTurnIntegrityKey,
  methods,
  padTurnFrame,
  parseMessage,
  splitTurnTcpFrames,
} from "../src";

const TURN_CREDENTIALS = {
  username: "turn-user",
  password: "turn-password",
  realm: "werift.test",
} as const;
const UDP_TRANSPORT = 0x11000000;

function makeAllocateRequest() {
  return new Message(methods.ALLOCATE, classes.REQUEST).setAttribute(
    "REQUESTED-TRANSPORT",
    UDP_TRANSPORT,
  );
}

function authenticateRequest(
  request: Message,
  nonce: Buffer,
  extraAttributes: [string, any][] = [],
) {
  for (const [key, value] of extraAttributes) {
    request.setAttribute(key as any, value);
  }

  request
    .setAttribute("USERNAME", TURN_CREDENTIALS.username)
    .setAttribute("REALM", TURN_CREDENTIALS.realm)
    .setAttribute("NONCE", nonce)
    .addMessageIntegrity(
      makeTurnIntegrityKey(
        TURN_CREDENTIALS.username,
        TURN_CREDENTIALS.realm,
        TURN_CREDENTIALS.password,
      ),
    )
    .addFingerprint();

  return request;
}

async function allocateRelay(
  protocol: TurnServerProtocol,
  client: {
    clientId: string;
    remoteAddress: Address;
    transport: "udp" | "tcp";
    localAddress: Address;
  },
  relayedAddress: Address,
) {
  const firstActions = protocol.handleClientDatagram({
    ...client,
    data: makeAllocateRequest().bytes,
  });
  const unauthorizedResponse = parseMessage(findSendClient(firstActions).data)!;
  const nonce = unauthorizedResponse.getAttributeValue("NONCE");

  const allocateRequest = authenticateRequest(makeAllocateRequest(), nonce);
  const allocateActions = protocol.handleClientDatagram({
    ...client,
    data: allocateRequest.bytes,
  });
  const bindRelayAction = findAction(allocateActions, "bind-relay");

  const successActions = protocol.handleRelayBound({
    allocationId: bindRelayAction.allocationId,
    relayId: bindRelayAction.relayId,
    relayedAddress,
  });
  const allocateResponse = parseMessage(findSendClient(successActions).data)!;

  return {
    nonce,
    relayId: bindRelayAction.relayId,
    response: allocateResponse,
  };
}

async function exchangeAllocate(
  server: NodeTurnServer,
  transport: "udp" | "tcp" | "tls",
) {
  const serverAddress =
    transport === "tls" ? server.tlsAddress! : server.address!;
  if (transport === "udp") {
    const client = createSocket("udp4");
    await new Promise<void>((resolve) => {
      client.bind({ address: "127.0.0.1", port: 0 }, resolve);
    });

    try {
      const firstResponsePromise = new Promise<Buffer>((resolve) => {
        client.once("message", (data) => resolve(data));
      });

      // 初回 Allocate で 401 と NONCE を受け取る。
      client.send(
        makeAllocateRequest().bytes,
        serverAddress[1],
        serverAddress[0],
      );
      const firstResponse = parseMessage(await firstResponsePromise)!;
      expect(firstResponse.getAttributeValue("ERROR-CODE")).toEqual([
        401,
        "Unauthorized",
      ]);

      const secondResponsePromise = new Promise<Buffer>((resolve) => {
        client.once("message", (data) => resolve(data));
      });

      // 認証付き Allocate を再送して relay candidate を取得する。
      const request = authenticateRequest(
        makeAllocateRequest(),
        firstResponse.getAttributeValue("NONCE"),
      );
      client.send(request.bytes, serverAddress[1], serverAddress[0]);
      return parseMessage(await secondResponsePromise)!;
    } finally {
      client.close();
    }
  }

  const socket =
    transport === "tls"
      ? connectTls({
          host: serverAddress[0],
          port: serverAddress[1],
          rejectUnauthorized: false,
        })
      : connect({
          host: serverAddress[0],
          port: serverAddress[1],
        });
  const readFrame = createTurnTcpReader(socket);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once(transport === "tls" ? "secureConnect" : "connect", () => {
        socket.off("error", reject);
        resolve();
      });
    });

    // 初回 Allocate で 401 と NONCE を受け取る。
    socket.write(padTurnFrame(makeAllocateRequest().bytes));
    const firstResponse = parseMessage(await readFrame())!;
    expect(firstResponse.getAttributeValue("ERROR-CODE")).toEqual([
      401,
      "Unauthorized",
    ]);

    // 認証付き Allocate を再送して relay candidate を取得する。
    const request = authenticateRequest(
      makeAllocateRequest(),
      firstResponse.getAttributeValue("NONCE"),
    );
    socket.write(padTurnFrame(request.bytes));
    return parseMessage(await readFrame())!;
  } finally {
    socket.destroy();
  }
}

function createTurnTcpReader(socket: TcpSocket | TLSSocket) {
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

function findSendClient(
  actions: ReturnType<TurnServerProtocol["handleTimer"]>,
) {
  const action = actions.find((candidate) => candidate.type === "send-client");
  if (!action || action.type !== "send-client") {
    throw new Error("Expected send-client action");
  }
  return action;
}

function findAction<TType extends TurnServerAction["type"]>(
  actions: TurnServerAction[],
  type: TType,
) {
  const action = actions.find((candidate) => candidate.type === type);
  if (!action || action.type !== type) {
    throw new Error(`Expected ${type} action`);
  }
  return action as Extract<TurnServerAction, { type: TType }>;
}

function readTlsAsset(name: string) {
  try {
    return readFileSync("./packages/dtls/assets/" + name);
  } catch (error) {
    return readFileSync("./../dtls/assets/" + name);
  }
}

function getLocalTlsServerOptions() {
  return {
    cert: readTlsAsset("cert.pem"),
    key: readTlsAsset("key.pem"),
  };
}

describe("TurnServerProtocol", () => {
  test("returns 401 and 438 for long-term credential authentication", () => {
    let now = 0;
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      nonceLifetime: 1,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
      now: () => now,
    });
    const client = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    // 認証なし Allocate で 401 と REALM/NONCE が返ることを確認する。
    const firstActions = protocol.handleClientDatagram({
      ...client,
      data: makeAllocateRequest().bytes,
    });
    const firstResponse = parseMessage(findSendClient(firstActions).data)!;
    expect(firstResponse.getAttributeValue("ERROR-CODE")).toEqual([
      401,
      "Unauthorized",
    ]);
    expect(firstResponse.getAttributeValue("REALM")).toBe(
      TURN_CREDENTIALS.realm,
    );

    now = 2_000;

    // 期限切れ NONCE を使った再送で 438 が返ることを確認する。
    const staleRequest = authenticateRequest(
      makeAllocateRequest(),
      firstResponse.getAttributeValue("NONCE"),
    );
    const staleActions = protocol.handleClientDatagram({
      ...client,
      data: staleRequest.bytes,
    });
    const staleResponse = parseMessage(findSendClient(staleActions).data)!;
    expect(staleResponse.getAttributeValue("ERROR-CODE")).toEqual([
      438,
      "Stale Nonce",
    ]);
    expect(
      staleResponse
        .getAttributeValue("NONCE")
        .equals(firstResponse.getAttributeValue("NONCE")),
    ).toBe(false);
  });

  test("relays channel data between allocations", async () => {
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
    });
    const clientA = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };
    const clientB = {
      clientId: "udp:127.0.0.1:5001",
      remoteAddress: ["127.0.0.1", 5001] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    const allocationA = await allocateRelay(protocol, clientA, [
      "127.0.0.1",
      40000,
    ]);
    const allocationB = await allocateRelay(protocol, clientB, [
      "127.0.0.1",
      40001,
    ]);
    expect(
      allocationA.response.getAttributeValue("XOR-RELAYED-ADDRESS"),
    ).toEqual(["127.0.0.1", 40000]);
    expect(
      allocationB.response.getAttributeValue("XOR-RELAYED-ADDRESS"),
    ).toEqual(["127.0.0.1", 40001]);

    const nonceA = allocationA.nonce;
    const nonceB = allocationB.nonce;

    // ChannelBind により permission と channel binding を張る。
    const channelBindA = authenticateRequest(
      new Message(methods.CHANNEL_BIND, classes.REQUEST)
        .setAttribute("CHANNEL-NUMBER", 0x4000)
        .setAttribute("XOR-PEER-ADDRESS", ["127.0.0.1", 40001]),
      nonceA,
    );
    const channelBindB = authenticateRequest(
      new Message(methods.CHANNEL_BIND, classes.REQUEST)
        .setAttribute("CHANNEL-NUMBER", 0x4001)
        .setAttribute("XOR-PEER-ADDRESS", ["127.0.0.1", 40000]),
      nonceB,
    );
    expect(
      parseMessage(
        findSendClient(
          protocol.handleClientDatagram({
            ...clientA,
            data: channelBindA.bytes,
          }),
        ).data,
      )?.messageClass,
    ).toBe(classes.RESPONSE);
    expect(
      parseMessage(
        findSendClient(
          protocol.handleClientDatagram({
            ...clientB,
            data: channelBindB.bytes,
          }),
        ).data,
      )?.messageClass,
    ).toBe(classes.RESPONSE);

    // ChannelData を relay へ送り出す。
    const relayActions = protocol.handleClientDatagram({
      ...clientA,
      data: encodeChannelData(0x4000, Buffer.from("hello")),
    });
    const relaySendAction = findAction(relayActions, "send-relay");
    expect(relaySendAction.remoteAddress).toEqual(["127.0.0.1", 40001]);

    // 相手 allocation で受けた relay パケットが ChannelData に戻ることを確認する。
    const forwardedActions = protocol.handleRelayPacket({
      relayId: allocationB.relayId,
      data: Buffer.from("hello"),
      remoteAddress: ["127.0.0.1", 40000],
      localAddress: ["127.0.0.1", 40001],
    });
    const clientSendAction = findAction(forwardedActions, "send-client");
    const channelData = decodeChannelData(clientSendAction.data)!;
    expect(channelData.channelNumber).toBe(0x4001);
    expect(channelData.data.toString()).toBe("hello");
  });

  test("keeps permissions valid across peer port changes on the same IP", async () => {
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
    });
    const client = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    const allocation = await allocateRelay(protocol, client, [
      "127.0.0.1",
      40000,
    ]);

    // CreatePermission で peer IP に対する permission を作る。
    const permissionRequest = authenticateRequest(
      new Message(methods.CREATE_PERMISSION, classes.REQUEST).setAttribute(
        "XOR-PEER-ADDRESS",
        ["127.0.0.1", 40001],
      ),
      allocation.nonce,
    );
    const permissionResponse = parseMessage(
      findSendClient(
        protocol.handleClientDatagram({
          ...client,
          data: permissionRequest.bytes,
        }),
      ).data,
    )!;

    // permission 作成が成功することを確認する。
    expect(permissionResponse.messageMethod).toBe(methods.CREATE_PERMISSION);
    expect(permissionResponse.messageClass).toBe(classes.RESPONSE);

    // 同一 IP で source port だけが変わった relay packet を投入する。
    const forwardedActions = protocol.handleRelayPacket({
      relayId: allocation.relayId,
      data: Buffer.from("hello"),
      remoteAddress: ["127.0.0.1", 49999],
      localAddress: ["127.0.0.1", 40000],
    });
    const clientSendAction = findAction(forwardedActions, "send-client");
    const indication = parseMessage(clientSendAction.data)!;

    // permission 判定が IP 単位で行われ、Data Indication が返ることを確認する。
    expect(indication.messageMethod).toBe(methods.DATA);
    expect(indication.getAttributeValue("XOR-PEER-ADDRESS")).toEqual([
      "127.0.0.1",
      49999,
    ]);
    expect(indication.getAttributeValue("DATA").toString()).toBe("hello");
  });

  test("rejects create permission when peer address family mismatches client transport", async () => {
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
    });
    const client = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    const allocation = await allocateRelay(protocol, client, [
      "127.0.0.1",
      40000,
    ]);

    // IPv4 client から IPv6 peer 宛の CreatePermission を送る。
    const permissionRequest = authenticateRequest(
      new Message(methods.CREATE_PERMISSION, classes.REQUEST).setAttribute(
        "XOR-PEER-ADDRESS",
        ["::1", 40001],
      ),
      allocation.nonce,
    );
    const permissionResponse = parseMessage(
      findSendClient(
        protocol.handleClientDatagram({
          ...client,
          data: permissionRequest.bytes,
        }),
      ).data,
    )!;

    // address family mismatch で 443 が返ることを確認する。
    expect(permissionResponse.getAttributeValue("ERROR-CODE")).toEqual([
      443,
      "Peer Address Family Mismatch",
    ]);
  });

  test("accepts channel number at the upper RFC boundary", async () => {
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
    });
    const client = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    const allocation = await allocateRelay(protocol, client, [
      "127.0.0.1",
      40000,
    ]);

    // RFC 上限の CHANNEL-NUMBER で ChannelBind を送る。
    const channelBindRequest = authenticateRequest(
      new Message(methods.CHANNEL_BIND, classes.REQUEST)
        .setAttribute("CHANNEL-NUMBER", 0x7fff)
        .setAttribute("XOR-PEER-ADDRESS", ["127.0.0.1", 40001]),
      allocation.nonce,
    );
    const channelBindResponse = parseMessage(
      findSendClient(
        protocol.handleClientDatagram({
          ...client,
          data: channelBindRequest.bytes,
        }),
      ).data,
    )!;

    // 上限値でも正常に ChannelBind できることを確認する。
    expect(channelBindResponse.messageMethod).toBe(methods.CHANNEL_BIND);
    expect(channelBindResponse.messageClass).toBe(classes.RESPONSE);
  });

  test("rejects invalid channel number above 0x7fff", async () => {
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
    });
    const client = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    const allocation = await allocateRelay(protocol, client, [
      "127.0.0.1",
      40000,
    ]);

    // 範囲外 CHANNEL-NUMBER で ChannelBind を送る。
    const channelBindRequest = authenticateRequest(
      new Message(methods.CHANNEL_BIND, classes.REQUEST)
        .setAttribute("CHANNEL-NUMBER", 0x8000)
        .setAttribute("XOR-PEER-ADDRESS", ["127.0.0.1", 40001]),
      allocation.nonce,
    );
    const channelBindResponse = parseMessage(
      findSendClient(
        protocol.handleClientDatagram({
          ...client,
          data: channelBindRequest.bytes,
        }),
      ).data,
    )!;

    // 仕様外の channel number には 400 を返すことを確認する。
    expect(channelBindResponse.getAttributeValue("ERROR-CODE")).toEqual([
      400,
      "Bad Request",
    ]);
  });

  test("rejects channel bind when peer address family mismatches client transport", async () => {
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
    });
    const client = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    const allocation = await allocateRelay(protocol, client, [
      "127.0.0.1",
      40000,
    ]);

    // IPv4 client から IPv6 peer 宛の ChannelBind を送る。
    const channelBindRequest = authenticateRequest(
      new Message(methods.CHANNEL_BIND, classes.REQUEST)
        .setAttribute("CHANNEL-NUMBER", 0x4000)
        .setAttribute("XOR-PEER-ADDRESS", ["::1", 40001]),
      allocation.nonce,
    );
    const channelBindResponse = parseMessage(
      findSendClient(
        protocol.handleClientDatagram({
          ...client,
          data: channelBindRequest.bytes,
        }),
      ).data,
    )!;

    // address family mismatch で 443 が返ることを確認する。
    expect(channelBindResponse.getAttributeValue("ERROR-CODE")).toEqual([
      443,
      "Peer Address Family Mismatch",
    ]);
  });

  test("updates allocation lifetime on refresh", async () => {
    let now = 0;
    const protocol = new TurnServerProtocol({
      realm: TURN_CREDENTIALS.realm,
      getPassword: (username) =>
        username === TURN_CREDENTIALS.username
          ? TURN_CREDENTIALS.password
          : undefined,
      now: () => now,
    });
    const client = {
      clientId: "udp:127.0.0.1:5000",
      remoteAddress: ["127.0.0.1", 5000] as Address,
      transport: "udp" as const,
      localAddress: ["127.0.0.1", 3478] as Address,
    };

    const allocation = await allocateRelay(protocol, client, [
      "127.0.0.1",
      40000,
    ]);

    now = 5_000;

    // Refresh で lifetime を短く更新する。
    const refreshRequest = authenticateRequest(
      new Message(methods.REFRESH, classes.REQUEST).setAttribute(
        "LIFETIME",
        10,
      ),
      allocation.nonce,
    );
    const refreshResponse = parseMessage(
      findSendClient(
        protocol.handleClientDatagram({
          ...client,
          data: refreshRequest.bytes,
        }),
      ).data,
    )!;

    // 応答値と内部 state の両方が更新されることを確認する。
    expect(refreshResponse.getAttributeValue("LIFETIME")).toBe(10);
    expect(
      (protocol as any).getClientAllocation(client.clientId)?.lifetime,
    ).toBe(10);
    expect(protocol.nextTimeoutAt).toBe(now + 10_000);
  });
});

describe("NodeTurnServer", () => {
  test.each(["udp", "tcp", "tls"] as const)(
    "serves Allocate over %s",
    async (transport) => {
      const server = new NodeTurnServer({
        host: "127.0.0.1",
        port: 0,
        relayAddress: "127.0.0.1",
        relayBindAddress: "127.0.0.1",
        realm: TURN_CREDENTIALS.realm,
        credentials: {
          [TURN_CREDENTIALS.username]: TURN_CREDENTIALS.password,
        },
        tls: transport === "tls" ? getLocalTlsServerOptions() : undefined,
      });
      await server.listen();

      try {
        const response = await exchangeAllocate(server, transport);

        // 認証後の Allocate 応答に relay candidate が含まれることを確認する。
        expect(response.messageClass).toBe(classes.RESPONSE);
        expect(response.messageMethod).toBe(methods.ALLOCATE);
        expect(response.getAttributeValue("XOR-RELAYED-ADDRESS")).toEqual([
          "127.0.0.1",
          expect.any(Number),
        ]);
        expect(response.getAttributeValue("XOR-MAPPED-ADDRESS")).toEqual([
          "127.0.0.1",
          expect.any(Number),
        ]);
      } finally {
        await server.close();
      }
    },
  );

  test("pads channel data on UDP responses", async () => {
    const server = new NodeTurnServer({
      host: "127.0.0.1",
      port: 0,
      relayAddress: "127.0.0.1",
      relayBindAddress: "127.0.0.1",
    });
    await server.listen();

    const client = createSocket("udp4");
    await new Promise<void>((resolve) => {
      client.bind({ address: "127.0.0.1", port: 0 }, resolve);
    });

    try {
      const localAddress = client.address();
      if (typeof localAddress === "string") {
        throw new Error("Expected UDP address info");
      }

      const received = new Promise<Buffer>((resolve) => {
        client.once("message", (data) => resolve(data));
      });

      // 奇数長の ChannelData を UDP クライアントへ返す。
      await (server as any).sendClient({
        type: "send-client",
        clientId: "udp:test",
        transport: "udp",
        remoteAddress: ["127.0.0.1", localAddress.port],
        data: encodeChannelData(0x4000, Buffer.from("hello")),
      });
      const frame = await received;

      // 4 byte alignment の padding が付いたまま受信できることを確認する。
      expect(frame.length).toBe(12);
      expect(decodeChannelData(frame)?.data.toString()).toBe("hello");
      expect(frame.subarray(9).equals(Buffer.alloc(3))).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });

  test("normalizes relay peer addresses only for matching relay sockets", () => {
    const server = new NodeTurnServer({
      host: "127.0.0.1",
      relayAddress: "127.0.0.1",
      relayBindAddress: "0.0.0.0",
    });
    (server as any).relaySockets.set("relay-1", {
      address: () => ({
        address: "0.0.0.0",
        family: "IPv4",
        port: 5000,
      }),
    });

    // relay socket 自身と一致する address/port だけ advertised address に正規化する。
    const relayAddress = (server as any).normalizeRelayRemoteAddress({
      address: "127.0.0.1",
      port: 5000,
    });
    const externalPeer = (server as any).normalizeRelayRemoteAddress({
      address: "192.0.2.10",
      port: 5000,
    });

    // port だけ一致する外部 peer は書き換えないことを確認する。
    expect(relayAddress).toEqual(["127.0.0.1", 5000]);
    expect(externalPeer).toEqual(["192.0.2.10", 5000]);
  });

  test("closes malformed tcp client connections", async () => {
    const server = new NodeTurnServer({
      host: "127.0.0.1",
      port: 0,
      relayAddress: "127.0.0.1",
      relayBindAddress: "127.0.0.1",
    });
    await server.listen();

    const socket = connect({
      host: server.address![0],
      port: server.address![1],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.off("error", reject);
          resolve();
        });
      });

      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });

      // 不正な TCP プレフィックスを送って接続が明示的に破棄されることを確認する。
      socket.write(Buffer.from([0x80, 0x00, 0x00, 0x00]));
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  test("ignores tcp client write races after disconnect", async () => {
    const server = new NodeTurnServer({
      host: "127.0.0.1",
      relayAddress: "127.0.0.1",
      relayBindAddress: "127.0.0.1",
    });

    const handleClientClosed = vi.spyOn(server.protocol, "handleClientClosed");
    (server as any).tcpConnections.set("tcp:test", {
      destroyed: false,
      write: (_data: Buffer, callback: (error?: Error) => void) => {
        callback(
          Object.assign(new Error("connection reset by peer"), {
            code: "ECONNRESET",
          }),
        );
      },
    });

    // Act: 切断済み TCP クライアントへ応答を書き戻す競合を再現し、サーバが例外で落ちないことを確認する。
    await expect(
      (server as any).sendClient({
        type: "send-client",
        clientId: "tcp:test",
        transport: "tcp",
        remoteAddress: ["127.0.0.1", 3478],
        data: Buffer.from([0x00]),
      }),
    ).resolves.toBeUndefined();

    // Assert: ECONNRESET は接続クローズとして扱い、protocol 側の後始末へ進めることを確認する。
    expect(handleClientClosed).toHaveBeenCalledWith({ clientId: "tcp:test" });
  });
});
