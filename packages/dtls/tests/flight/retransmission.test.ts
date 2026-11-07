import { setTimeout as delay } from "node:timers/promises";

import { DtlsClient } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, createSilentTransport, keyPem } from "../fixture";

describe("flight retransmission", () => {
  test("stops when the socket closes during the handshake", async () => {
    // Arrange: 応答しない相手に ClientHello を送り始めた client。
    const { transport, sent } = createSilentTransport();
    const client = new DtlsClient({
      transport,
      cert: certPem,
      key: keyPem,
      signatureHash: {
        hash: HashAlgorithm.sha256_4,
        signature: SignatureAlgorithm.rsa_1,
      },
    });
    const timers = process
      .getActiveResourcesInfo()
      .filter((t) => t === "Timeout");
    void client.connect().catch(() => undefined);
    await delay(50);
    expect(sent.length).toBe(1);

    // Act: handshake の途中で socket を閉じる。
    client.close();
    await delay(700);

    // Assert: 再送しなくなり、再送待ちの timer も残らない。
    expect(sent.length).toBe(1);
    expect(
      process.getActiveResourcesInfo().filter((t) => t === "Timeout").length,
    ).toBeLessThanOrEqual(timers.length);
  });
});
