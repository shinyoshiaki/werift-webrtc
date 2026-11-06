import { describe, expect, test } from "vitest";
import { type DtlsSocket, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { arrangeDtls13Pair, arrangePartialDtls13Handshake } from "../fixture";

/**
 * readiness のライフサイクル契約: 各 milestone は association で一度 true に
 * なったら close 後も false に戻らず、到達済み milestone の waiter は close 後も
 * resolve する。DTLS 1.3、dual 設定 (1.3 を含む) から 1.2 への接続、1.2-only の
 * いずれでも同じであること。
 */
const ready = {
  writeReady: true,
  peerHandshakeAuthenticated: true,
  handshakeComplete: true,
};

const waiters = (socket: DtlsSocket) => [
  socket.waitForWriteReady(),
  socket.waitForPeerHandshakeAuthenticated(),
  socket.waitForHandshakeComplete(),
];

describe.each([
  { name: "DTLS 1.3", client: [DtlsVersion.V1_3], server: [DtlsVersion.V1_3] },
  {
    name: "dual client → 1.2 server",
    client: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    server: [DtlsVersion.V1_2],
  },
  { name: "DTLS 1.2", client: [DtlsVersion.V1_2], server: [DtlsVersion.V1_2] },
])(
  "e2e/self readiness latch ($name)",
  ({ client: clientVersions, server: serverVersions }) => {
    test("接続で一度だけ true になり、close 後も戻らず、到達済み waiter は resolve する", async () => {
      // Arrange: 指定 version の self pair
      const { server, client, serverTransport, clientTransport } =
        await arrangeDtls13Pair({
          protocolVersions: clientVersions,
          serverProtocolVersions: serverVersions,
          signatureHash: {
            hash: HashAlgorithm.sha256_4,
            signature: SignatureAlgorithm.rsa_1,
          },
        });

      try {
        // Assert: 接続前はどの milestone にも達していない
        expect(client.readiness.writeReady).toBe(false);

        // Act: handshake を完了させ、両側の handshakeComplete を待つ
        const connected = Promise.all([
          server.onConnect.asPromise(),
          client.onConnect.asPromise(),
        ]);
        await client.connect();
        await connected;
        await Promise.all([
          client.waitForHandshakeComplete(),
          server.waitForHandshakeComplete(),
        ]);

        // Assert: 想定した version で全 milestone に達している
        const expect13 = serverVersions.includes(DtlsVersion.V1_3);
        expect(client.isDtls13).toBe(expect13);
        expect(client.readiness).toEqual(ready);
        expect(server.readiness).toEqual(ready);

        // Act: 両側を close する
        client.close();
        server.close();

        // Assert: close 後も readiness は true のまま (終了は onClose で通知)
        expect(client.readiness).toEqual(ready);
        expect(server.readiness).toEqual(ready);
        // Assert: 到達済み milestone の waiter は close 後でも resolve する
        await expect(Promise.all(waiters(client))).resolves.toBeDefined();
        await expect(Promise.all(waiters(server))).resolves.toBeDefined();
      } finally {
        client.close();
        server.close();
        await Promise.allSettled([
          serverTransport.close(),
          clientTransport.close(),
        ]);
      }
    });
  },
);

const reachedBy = {
  "server-before-peer-finished": {
    writeReady: true,
    peerHandshakeAuthenticated: false,
    handshakeComplete: false,
  },
  "client-before-final-ack": {
    writeReady: true,
    peerHandshakeAuthenticated: true,
    handshakeComplete: false,
  },
} as const;

const settledWaiters = (socket: DtlsSocket) =>
  Promise.all(
    waiters(socket).map((waiter) =>
      waiter.then(
        () => "resolved",
        () => "rejected",
      ),
    ),
  );

const expectedWaiters = (reached: Record<string, boolean>) =>
  [
    reached.writeReady,
    reached.peerHandshakeAuthenticated,
    reached.handshakeComplete,
  ].map((r) => (r ? "resolved" : "rejected"));

describe.each([
  { stop: "server-before-peer-finished" as const },
  { stop: "client-before-final-ack" as const },
])("e2e/self readiness latch: handshake 途中の終了 ($stop)", ({ stop }) => {
  test.each([{ end: "close" as const }, { end: "fatal failure" as const }])(
    "$end 後も milestone ごとの到達状態を保ち、到達済みの waiter だけが resolve する",
    async ({ end }) => {
      // Arrange: handshake 途中で止まった DTLS 1.3 pair
      const pair = await arrangePartialDtls13Handshake(stop);
      const { stopped, release } = pair;
      try {
        // Assert: 前提として、止めた位置までの milestone だけに達している
        expect(stopped.readiness).toEqual(reachedBy[stop]);

        // Act: その側を close する、または致命的な失敗で終了させる
        if (end === "close") {
          stopped.close();
        } else {
          (
            stopped as unknown as {
              engine13: { fail(error: Error): void };
            }
          ).engine13.fail(new Error("injected fatal failure"));
        }
        await new Promise((resolve) => setImmediate(resolve));

        // Assert: 終了後も到達済みは true、未到達は false のまま
        expect(stopped.isDtls13).toBe(false);
        expect(stopped.readiness).toEqual(reachedBy[stop]);
        // Assert: 到達済み milestone の waiter は resolve、未到達は reject する
        expect(await settledWaiters(stopped)).toEqual(
          expectedWaiters(reachedBy[stop]),
        );
      } finally {
        release();
        pair.client.close();
        pair.server.close();
        await Promise.allSettled([
          pair.serverTransport.close(),
          pair.clientTransport.close(),
        ]);
      }
    },
  );
});
