import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { vi } from "vitest";

import { TcpTransport } from "../../../common/src";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import { createTurnClient, TurnProtocol } from "../../src/turn/protocol";
import {
  activeResourceCount,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
} from "../utils";

const credentials = {
  username: TURN_TEST_USERNAME,
  password: TURN_TEST_PASSWORD,
};

async function listenTcp(reply: (request: Message) => Message) {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (data) => socket.write(reply(parseMessage(data)!).bytes));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, sockets, port };
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe("close() racing a TURN client that already has its answer", () => {
  test("releases the TCP connection a redirect reconnected after close()", async () => {
    // Arrange: 403 を返す転送先と、そこへ 300 (Try Alternate) で誘導する server。
    const alternate = await listenTcp((request) =>
      new Message(
        methods.ALLOCATE,
        classes.ERROR,
        request.transactionId,
      ).setAttribute("ERROR-CODE", [403, "Forbidden"]),
    );
    const redirector = await listenTcp((request) =>
      new Message(methods.ALLOCATE, classes.ERROR, request.transactionId)
        .setAttribute("ERROR-CODE", [300, "Try Alternate"])
        .setAttribute("ALTERNATE-SERVER", ["127.0.0.1", alternate.port]),
    );
    // 転送先への接続が確立した直後で止め、close() がそこへ割り込めるようにする。
    const original = TcpTransport.init;
    let reconnected: TcpTransport | undefined;
    let entered!: () => void;
    let release!: () => void;
    const connected = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi
      .spyOn(TcpTransport, "init")
      .mockImplementation(async (...args: Parameters<typeof original>) => {
        const transport = await original.apply(TcpTransport, args);
        if (args[0][1] === alternate.port) {
          reconnected = transport;
          entered();
          await gate;
        }
        return transport;
      });
    const closing = new AbortController();
    try {
      const pending = createTurnClient(
        { address: ["127.0.0.1", redirector.port], ...credentials },
        { transport: "tcp", signal: closing.signal },
      ).then(
        () => "success",
        (error: Error) => error.constructor.name,
      );
      await connected;

      // Act: 再接続の待機中に close() し、その後で再接続を完了させる。
      closing.abort();
      await delay(10);
      release();
      const result = await pending;
      await delay(20);

      // Assert: 失敗として終わり、後から得た接続も閉じられて server 側にも残らない。
      expect(result).toBe("TransactionCancelled");
      expect(reconnected?.closed).toBe(true);
      expect(alternate.sockets.size).toBe(0);
    } finally {
      spy.mockRestore();
      release();
      if (reconnected && !reconnected.closed) await reconnected.close();
      for (const socket of [...alternate.sockets, ...redirector.sockets])
        socket.destroy();
      await Promise.all([
        closeServer(alternate.server),
        closeServer(redirector.server),
      ]);
    }
  });

  test("starts no refresh timer when close() runs as the Allocate response is handled", async () => {
    // Arrange: Allocate に成功を返す UDP server。
    const server = createSocket("udp4");
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
    server.on("message", (data, info) => {
      const request = parseMessage(data)!;
      const response = new Message(
        methods.ALLOCATE,
        classes.RESPONSE,
        request.transactionId,
      )
        .setAttribute("XOR-RELAYED-ADDRESS", ["127.0.0.1", 50000])
        .setAttribute("XOR-MAPPED-ADDRESS", [info.address, info.port])
        .setAttribute("LIFETIME", 600);
      server.send(response.bytes, info.port, info.address);
    });
    const controller = new AbortController();
    const original = TurnProtocol.prototype.request;
    let client: TurnProtocol | undefined;
    // Allocate の応答を受け取った直後 (connectionMade が再開する前) に abort する。
    const spy = vi
      .spyOn(TurnProtocol.prototype, "request")
      .mockImplementation(async function (this: TurnProtocol, ...args) {
        client = this;
        const response = await original.apply(this, args);
        if (args[0].messageMethod === methods.ALLOCATE) controller.abort();
        return response;
      });
    const timersBefore = activeResourceCount("Timeout");
    try {
      // Act: abort に追い越された allocation を待つ。
      const result = await createTurnClient(
        {
          address: ["127.0.0.1", (server.address() as { port: number }).port],
          ...credentials,
        },
        { signal: controller.signal },
      ).then(
        () => "success",
        (error: Error) => error.constructor.name,
      );
      await delay(20);

      // Assert: 失敗として終わり、transport は閉じ、refresh の timer は作られない。
      expect(result).toBe("TransactionCancelled");
      expect(client!.transport.closed).toBe(true);
      expect(activeResourceCount("Timeout")).toBeLessThanOrEqual(timersBefore);
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
