import { describe, expect, test } from "vitest";
import { type Address, UdpTransport } from "../../../common/src";
import { DtlsServer, DtlsVersion } from "../../src";
import { CipherSuite } from "../../src/cipher/const";
import { NamedCurveAlgorithm } from "../../src/cipher/const";
import { generateKeyPair } from "../../src/cipher/namedCurve";
import { ANTI_AMPLIFICATION_FACTOR } from "../../src/engine/v1_3/types";
import { EllipticCurves } from "../../src/handshake/extensions/ellipticCurves";
import { KeyShare } from "../../src/handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../src/handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../src/handshake/extensions/supportedVersions";
import { ClientHello } from "../../src/handshake/message/client/hello";
import { DtlsRandom } from "../../src/handshake/random";
import { ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { DTLS_1_3_VERSION, WireVersion } from "../../src/version";
import { certPem, keyPem } from "../fixture";

/**
 * Build a minimal DTLS 1.3 ClientHello epoch-0 record for anti-amp probing.
 */
function buildProbeClientHello(): Buffer {
  const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
  const curves = EllipticCurves.createEmpty();
  curves.data = [NamedCurveAlgorithm.x25519_29] as any;
  const ch = new ClientHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.alloc(0),
    [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
    [0],
    [
      SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension,
      curves.extension,
      KeyShare.forClient([
        { group: NamedCurveAlgorithm.x25519_29, keyExchange: kp.publicKey },
      ]).clientExtension,
      SignatureAlgorithms.create().extension,
    ],
  );
  ch.messageSeq = 0;
  const frag = ch.toFragment();
  frag.message_seq = 0;
  return serializePlaintextRecord(
    ContentType.handshake,
    0,
    0,
    frag.serialize(),
  );
}

describe("anti-amplification budget (per association peer)", () => {
  test("server total TX ≤ 3× RX from the associated source before validation", async () => {
    // Arrange: cookie-validated server; capture all outbound
    const sent: Buffer[] = [];
    const serverTransport = await UdpTransport.init("udp4");
    const originalSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (buf: Buffer, addr?: Address) => {
      sent.push(Buffer.from(buf));
      return originalSend(buf, addr);
    };
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "dtls-cookie",
    });

    const probe = buildProbeClientHello();
    const peer: Address = ["203.0.113.1", 40000];
    // Act: flood many unauthenticated ClientHellos from the *same* source
    // (retransmits / retries before cookie). Budget is 3× bytes from this peer.
    const floodCount = 8;
    for (let i = 0; i < floodCount; i++) {
      serverTransport.onData?.(probe, peer as any);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 100));

    const totalSent = sent.reduce((n, b) => n + b.length, 0);
    const totalRecv = probe.length * floodCount;

    // Assert: outbound never exceeds 3× inbound from the associated peer
    expect(totalSent).toBeLessThanOrEqual(
      ANTI_AMPLIFICATION_FACTOR * totalRecv,
    );
    expect(totalSent).toBeGreaterThan(0);

    server.close();
    await serverTransport.close();
  }, 15_000);

  test("foreign sources after association lock do not inflate RX budget", async () => {
    // Arrange
    const sent: Buffer[] = [];
    const sendAddrs: Array<Address | undefined> = [];
    const serverTransport = await UdpTransport.init("udp4");
    const originalSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (buf: Buffer, addr?: Address) => {
      sent.push(Buffer.from(buf));
      sendAddrs.push(addr);
      return originalSend(buf, addr);
    };
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "dtls-cookie",
    });

    const probe = buildProbeClientHello();
    const realPeer: Address = ["203.0.113.10", 50000];
    // Act: first CH locks the association peer
    serverTransport.onData?.(probe, realPeer as any);
    await new Promise((r) => setTimeout(r, 50));
    const sentAfterFirst = sent.reduce((n, b) => n + b.length, 0);

    // Flood from *other* 5-tuples (must not count toward budget / redirect TX)
    for (let i = 0; i < 10; i++) {
      serverTransport.onData?.(probe, ["198.51.100.1", 60000 + i] as any);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 50));

    const sentAfterFlood = sent.reduce((n, b) => n + b.length, 0);
    // Assert: no additional TX driven by foreign sources
    expect(sentAfterFlood).toBe(sentAfterFirst);
    // All TX was directed at the real peer (explicit address)
    for (const a of sendAddrs) {
      expect(a).toEqual(realPeer);
    }
    // Budget still ≤ 3× single real CH (not 11× CH from attackers)
    expect(sentAfterFlood).toBeLessThanOrEqual(
      ANTI_AMPLIFICATION_FACTOR * probe.length,
    );

    server.close();
    await serverTransport.close();
  }, 15_000);
});
