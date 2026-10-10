import { TcpTransport, TlsTransport, UdpTransport } from "../src/transport";
import { createHangingStreamServer } from "./utils";

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

describe("UdpTransport send semantics", () => {
  test("IP send is fire-and-forget; sendAndWait awaits the kernel callback", async () => {
    // Arrange
    const t = await UdpTransport.init("udp4");
    let callbackInvoked = false;
    const orig = t.socket.send.bind(t.socket);
    t.socket.send = ((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const rest = args.slice(0, -1) as Parameters<typeof orig>;
        const ret = orig(...rest);
        setTimeout(() => {
          callbackInvoked = true;
          (last as (err: Error | null) => void)(null);
        }, 40);
        return ret;
      }
      return orig(...(args as Parameters<typeof orig>));
    }) as typeof t.socket.send;

    try {
      // Act: 解決済み IP への send は callback を待たない
      await t.send(Buffer.from("hot"), ["127.0.0.1", t.port]);
      // Assert
      expect(callbackInvoked).toBe(false);

      // Act: close_notify 用 flush は callback 完了を待つ
      const flushed = t.sendAndWait(Buffer.from("flush"), [
        "127.0.0.1",
        t.port,
      ]);
      expect(callbackInvoked).toBe(false);
      await flushed;
      expect(callbackInvoked).toBe(true);
    } finally {
      await t.close();
    }
  });
});
