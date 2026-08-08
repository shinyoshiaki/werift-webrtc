import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
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

describe("anti-amplification aggregate budget", () => {
  test("server total TX ≤ 3× RX before address validation (flood probe)", async () => {
    // Arrange: cookie-validated server; capture all outbound
    const sent: Buffer[] = [];
    const serverTransport = await UdpTransport.init("udp4");
    const originalSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      return originalSend(buf);
    };
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "dtls-cookie",
    });

    const probe = buildProbeClientHello();
    // Act: flood many unauthenticated ClientHellos (no valid cookie)
    const floodCount = 8;
    for (let i = 0; i < floodCount; i++) {
      // Different sequence numbers so records are distinct on the wire
      const pkt = serializePlaintextRecord(
        ContentType.handshake,
        0,
        i,
        probe.subarray(13), // re-use body? better rebuild full
      );
      // Simpler: inject the same probe repeatedly via onData
      serverTransport.onData?.(probe, ["203.0.113.1", 40000 + i] as any);
      await new Promise((r) => setTimeout(r, 5));
    }
    // Allow async RX chain to flush
    await new Promise((r) => setTimeout(r, 100));

    const totalSent = sent.reduce((n, b) => n + b.length, 0);
    const totalRecv = probe.length * floodCount;

    // Assert: aggregate outbound never exceeds 3× inbound (anti-amp)
    expect(totalSent).toBeLessThanOrEqual(
      ANTI_AMPLIFICATION_FACTOR * totalRecv,
    );

    server.close();
    await serverTransport.close();
  }, 15_000);
});
