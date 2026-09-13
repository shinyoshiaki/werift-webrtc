import { TcpTransport, TlsTransport } from "../src/transport";
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
