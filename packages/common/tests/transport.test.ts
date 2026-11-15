import * as dgram from "node:dgram";

import { TcpTransport, TlsTransport, UdpTransport } from "../src/transport";
import {
  createHangingStreamServer,
  createLoopbackUdpTransport,
  createRecvmsgConnRefusedError,
  occupyUdpPort,
  waitForUdpData,
} from "./utils";

describe("stream transport connection timeout", () => {
  test("times out and destroys a socket when TLS negotiation never completes", async () => {
    // Arrange: TCP 接続だけを受理し、TLS handshake に応答しないサーバーを用意する。
    const server = await createHangingStreamServer();
    const startedAt = Date.now();

    try {
      // Act: 短い上限時間で TLS transport の初期化を試みる。
      await expect(
        TlsTransport.init(
          server.address,
          { rejectUnauthorized: false },
          {
            connectTimeoutMs: 200,
          },
        ),
      ).rejects.toThrow("tls connect timed out after 200ms");

      // Assert: OS の接続待ちに依存せず終了し、サーバー側の socket も閉じられる。
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally {
      await server.close();
    }
  });

  test("bounds a pending TCP connection attempt", async () => {
    // Arrange: 外部へルーティングされない TEST-NET 宛先と短い上限時間を設定する。
    const startedAt = Date.now();

    // Act: TCP transport の初期化が失敗するまで待つ。
    await expect(
      TcpTransport.init(["192.0.2.1", 9], { connectTimeoutMs: 200 }),
    ).rejects.toThrow();

    // Assert: OS の長い SYN timeout を待たず、指定時間付近で処理が戻る。
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("UdpTransport bindAddress", () => {
  test("binds the socket to bindAddress", async () => {
    // Act: bindAddress を指定して初期化する
    const transport = await UdpTransport.init("udp4", {
      bindAddress: "127.0.0.1",
    });

    try {
      // Assert: wildcard ではなく指定アドレスに bind される
      expect(transport.address.address).toBe("127.0.0.1");
    } finally {
      await transport.close();
    }
  });

  test("bindAddress takes precedence over interfaceAddresses", async () => {
    // Act: interfaceAddresses (wildcard) と bindAddress を両方指定する
    const transport = await UdpTransport.init("udp4", {
      interfaceAddresses: { udp4: "0.0.0.0" },
      bindAddress: "127.0.0.1",
    });

    try {
      // Assert: bindAddress が優先される
      expect(transport.address.address).toBe("127.0.0.1");
    } finally {
      await transport.close();
    }
  });

  test("bindAddress with portRange binds a port of the range on that address", async () => {
    // Act: portRange と bindAddress を指定して初期化する
    const transport = await UdpTransport.init("udp4", {
      bindAddress: "127.0.0.1",
      portRange: [45400, 45500],
    });

    try {
      // Assert: 指定アドレスの範囲内ポートに bind される
      const { address, port } = transport.address;
      expect(address).toBe("127.0.0.1");
      expect(port).toBeGreaterThanOrEqual(45400);
      expect(port).toBeLessThanOrEqual(45500);
    } finally {
      await transport.close();
    }
  });

  test("rejects init and closes the socket when bindAddress is not assigned locally", async () => {
    // Arrange: ソケットの close を記録する
    const close = vi.spyOn(dgram.Socket.prototype, "close");

    try {
      // Act: このホストにない TEST-NET-1 アドレスへの bind を試みる
      const init = UdpTransport.init("udp4", { bindAddress: "192.0.2.1" });

      // Assert: EADDRNOTAVAIL で reject され、作成したソケットは閉じられる
      await expect(init).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});

describe("UdpTransport socket error handling", () => {
  test("rejects init and closes the socket when bind fails", async () => {
    // Arrange: 使用中のポートを用意する。
    const occupied = await occupyUdpPort();

    try {
      // Act: 同じポートへの bind を試みる。
      const init = createLoopbackUdpTransport({ port: occupied.port });

      // Assert: uncaught exception にならず、EADDRINUSE で reject される。
      await expect(init).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await occupied.close();
    }
  });

  test("rejects init without leaking the socket when no port is free", async () => {
    // Arrange: portRange 内の唯一のポートを占有する。
    const occupied = await occupyUdpPort();

    try {
      // Act: 空きのない portRange で初期化を試みる。
      const init = createLoopbackUdpTransport({
        portRange: [occupied.port, occupied.port],
      });

      // Assert: findPort の失敗がそのまま reject される。
      await expect(init).rejects.toThrow("port not found");
    } finally {
      await occupied.close();
    }
  });

  test("routes a runtime socket error to onError and keeps the socket usable", async () => {
    // Arrange: 送受信用の transport 2 つとエラー受信の記録先を用意する。
    const transport = await createLoopbackUdpTransport();
    const peer = await createLoopbackUdpTransport();
    const errors: Error[] = [];
    transport.onError.subscribe((error) => errors.push(error));
    const error = createRecvmsgConnRefusedError();

    try {
      // Act: Bun の recvmsg ECONNREFUSED 相当を socket の error として emit する。
      transport.socket.emit("error", error);

      // Assert: 例外にならず onError に 1 回だけ通知され、transport は閉じない。
      expect(errors).toEqual([error]);
      expect(transport.closed).toBe(false);

      // Act: エラー後もピアとの間で送信できるか確認する。
      const received = waitForUdpData(peer);
      await transport.send(Buffer.from("ping"), ["127.0.0.1", peer.port]);

      // Assert: 一過性のエラーとして扱われ、データが届く。
      expect((await received).toString()).toBe("ping");
    } finally {
      await transport.close();
      await peer.close();
    }
  });

  test("handles ECONNREFUSED after the remote endpoint disappears", async () => {
    // Arrange: ピアを閉じて、その宛先ポートを記録しておく。
    const transport = await createLoopbackUdpTransport();
    const peer = await createLoopbackUdpTransport();
    const closedPort = peer.port;
    await peer.close();
    const errors: Error[] = [];
    transport.onError.subscribe((error) => errors.push(error));

    try {
      // Act: 閉じたポートへ送信し、ランタイムが出す可能性のある error を注入する。
      await transport.send(Buffer.from("rtp"), ["127.0.0.1", closedPort]);
      transport.socket.emit("error", createRecvmsgConnRefusedError());
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Assert: プロセスは落ちず、ECONNREFUSED が通知され、transport は開いたまま。
      expect(errors.map((e) => (e as NodeJS.ErrnoException).code)).toContain(
        "ECONNREFUSED",
      );
      expect(transport.closed).toBe(false);
    } finally {
      await transport.close();
    }
  });

  test("close is idempotent after a runtime error", async () => {
    // Arrange: ランタイムエラーを受けた transport を用意する。
    const transport = await createLoopbackUdpTransport();
    transport.socket.emit("error", createRecvmsgConnRefusedError());

    // Act: close を連続で呼ぶ。
    const results = Promise.all([transport.close(), transport.close()]);

    // Assert: 2 回とも resolve し、追加の close も resolve する。
    await expect(results).resolves.toBeDefined();
    await expect(transport.close()).resolves.toBeUndefined();
    expect(transport.closed).toBe(true);
  });

  test("releases the socket when an onError completion handler throws", async () => {
    // Arrange: 完了コールバックが例外を投げる onError 購読者を持つ transport を用意する。
    const transport = await createLoopbackUdpTransport();
    const port = transport.port;
    transport.onError.subscribe(
      () => {},
      () => {
        throw new Error("onError complete failed");
      },
    );

    // Act: 完了通知が例外を投げる状態で close する。
    await expect(transport.close()).resolves.toBeUndefined();

    // Assert: 例外後もソケットが解放され、同じポートを再利用できる。
    const reused = await createLoopbackUdpTransport({ port });
    expect(reused.port).toBe(port);
    await reused.close();
  });

  test("does not settle twice or notify errors after close", async () => {
    // Arrange: 初期化済みの transport とエラー受信の記録先を用意する。
    const transport = await createLoopbackUdpTransport();
    const errors: Error[] = [];
    transport.onError.subscribe((error) => errors.push(error));

    // Act: listening 後に error を emit してから close し、close 後にも error を emit する。
    transport.socket.emit("error", createRecvmsgConnRefusedError());
    await transport.close();
    transport.socket.emit("error", createRecvmsgConnRefusedError());

    // Assert: close 前のエラーだけが通知され、close 後のエラーは例外にも通知にもならない。
    expect(errors).toHaveLength(1);
  });

  test("ignores a late listening event after close", async () => {
    // Arrange: 初期化済みの transport を閉じておく。
    const transport = await createLoopbackUdpTransport();
    await transport.close();

    // Act: close 後に listening / error を emit する。
    const emitLate = () => {
      transport.socket.emit("listening");
      transport.socket.emit("error", createRecvmsgConnRefusedError());
    };

    // Assert: init の Promise は再 settle されず、例外も発生しない。
    expect(emitLate).not.toThrow();
    expect(transport.closed).toBe(true);
  });
});
