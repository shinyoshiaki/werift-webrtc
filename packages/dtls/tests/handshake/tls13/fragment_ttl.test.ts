import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { SessionType } from "../../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../../src/engine/v1_3/connection";
import { FRAGMENT_TTL_MS } from "../../../src/engine/v1_3/types";
import { HandshakeType } from "../../../src/handshake/const";
import { FragmentedHandshake } from "../../../src/record/message/fragment";
import { certPem, keyPem } from "../../fixture";

/**
 * Fragment buffer accounting: on create we reserve `total` bytes;
 * on TTL expiry we must free `total` (not coveredBytes which starts at 0).
 */
describe("security bounds: fragment TTL accounting", () => {
  test("expired incomplete fragments free reserved bytes", async () => {
    // Arrange: 前提を準備する
    const transport = await UdpTransport.init("udp4");
    const server = new Dtls13Connection(
      {
        transport,
        cert: certPem,
        key: keyPem,
        addressValidation: "none",
      },
      SessionType.SERVER,
    );
    const eng = server as any;
    // Build an incomplete handshake fragment (first half only)
    const total = 100;
    const part = new FragmentedHandshake(
      HandshakeType.certificate_11,
      total,
      0,
      0,
      40,
      Buffer.alloc(40, 0xab),
    );
    // Act: フラグメント処理を検証する
    const incomplete = eng.reassemble(part);
    expect(incomplete).toBeNull();
    expect(eng.fragmentBuffer.size).toBe(1);
    expect(eng.fragmentBufferBytes).toBe(total);

    // Age the entry past TTL
    const key = [...eng.fragmentBuffer.keys()][0];
    eng.fragmentBuffer.get(key).createdAt = Date.now() - FRAGMENT_TTL_MS - 1;

    // Act: フラグメント処理を検証する
    eng.evictExpiredFragments();

    // Assert: フラグメント処理を検証する
    expect(eng.fragmentBuffer.size).toBe(0);
    expect(eng.fragmentBufferBytes).toBe(0);

    // Act: フラグメント処理を検証する
    const part2 = new FragmentedHandshake(
      HandshakeType.certificate_11,
      total,
      1,
      0,
      40,
      Buffer.alloc(40, 0xcd),
    );
    expect(eng.reassemble(part2)).toBeNull();
    expect(eng.fragmentBufferBytes).toBe(total);

    server.close();
  });
});
