import { expect, test } from "vitest";
import { DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { arrangeDtls13Pair } from "../fixture";

/**
 * readiness のライフサイクル契約: DTLS 1.3 engine と同じく、DTLS 1.2 でも
 * 各 milestone は association で一度 true になったら close 後も false に戻らない。
 */
test("e2e/self12 readiness は接続で一度だけ true になり、close 後も戻らない", async () => {
  // Arrange: DTLS 1.2 の self pair
  const { server, client, serverTransport, clientTransport } =
    await arrangeDtls13Pair({
      protocolVersions: [DtlsVersion.V1_2],
      signatureHash: {
        hash: HashAlgorithm.sha256_4,
        signature: SignatureAlgorithm.rsa_1,
      },
    });
  const notReady = {
    writeReady: false,
    peerHandshakeAuthenticated: false,
    handshakeComplete: false,
  };
  const ready = {
    writeReady: true,
    peerHandshakeAuthenticated: true,
    handshakeComplete: true,
  };

  try {
    // Assert: 接続前はどの milestone にも達していない
    expect(client.readiness).toEqual(notReady);

    // Act: handshake を完了させる
    const connected = Promise.all([
      server.onConnect.asPromise(),
      client.onConnect.asPromise(),
    ]);
    await client.connect();
    await connected;

    // Assert: 1.2 では接続で 3 つの milestone に同時に達する
    expect(client.isDtls13).toBe(false);
    expect(client.readiness).toEqual(ready);
    expect(server.readiness).toEqual(ready);

    // Act: client を close する
    client.close();

    // Assert: close しても readiness は true のまま (終了は onClose で通知)
    expect(client.connected).toBe(false);
    expect(client.readiness).toEqual(ready);
    // Assert: 到達済みの milestone の waiter は close 後でも即座に resolve する
    await expect(client.waitForPeerHandshakeAuthenticated()).resolves.toBe(
      undefined,
    );
    await expect(client.waitForHandshakeComplete()).resolves.toBe(undefined);
  } finally {
    client.close();
    server.close();
    await Promise.allSettled([
      serverTransport.close(),
      clientTransport.close(),
    ]);
  }
});
