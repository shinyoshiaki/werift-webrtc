import { describe, expect, test } from "vitest";
import { type DtlsSocket, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { arrangeDtls13Pair } from "../fixture";

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
