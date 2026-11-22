import { arrangeDtls13Pair } from "../fixture";

/**
 * DTLS 1.3 の公開イベントも DTLS 1.2 と同じく購読者ごとに隔離して通知する
 * （先に登録したリスナーの例外で、後のリスナーや association の後始末を止めない）。
 */
describe("e2e/self13: listener isolation", () => {
  test("onConnect / onData / onClose のリスナーが例外を投げても後のリスナーと transport の close まで進む", async () => {
    // Arrange: DTLS 1.3 の接続済み pair。server の各イベントで先に例外を投げるリスナーを登録する
    const { server, client, serverTransport, clientTransport } =
      await arrangeDtls13Pair();
    const later: string[] = [];
    server.onConnect.subscribe(() => {
      throw new Error("onConnect listener failed");
    });
    server.onConnect.subscribe(() => later.push("connect"));
    server.onData.subscribe(() => {
      throw new Error("onData listener failed");
    });
    server.onData.subscribe((data) => later.push(`data:${data.toString()}`));
    server.onClose.subscribe(() => {
      throw new Error("onClose listener failed");
    });
    server.onClose.subscribe(() => later.push("close"));
    const received = new Promise<void>((resolve) =>
      server.onData.subscribe(() => resolve()),
    );
    try {
      await client.connect();
      await new Promise<void>((resolve) => {
        if (server.connected) resolve();
        else server.onConnect.subscribe(() => resolve());
      });

      // Act: client からデータを送り、その後 server をローカルで close する
      await client.send(Buffer.from("ping"));
      await received;
      await server.close();
      // close_notify の送信後に engine が onClose を出すまで待つ
      await new Promise((r) => setTimeout(r, 300));

      // Assert: 例外を投げたリスナーの後のリスナーが各イベントで呼ばれる
      expect(later).toEqual(["connect", "data:ping", "close"]);
      // Assert: onClose のリスナーの例外で association の後始末が止まらず、transport が閉じる
      expect(serverTransport.closed).toBe(true);
    } finally {
      client.close();
      await clientTransport.close().catch(() => {});
      await serverTransport.close().catch(() => {});
    }
  }, 20_000);
});
