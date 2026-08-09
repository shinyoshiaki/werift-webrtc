import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { CipherSuite } from "../../src/cipher/const";
import { NamedCurveAlgorithm } from "../../src/cipher/const";
import { generateKeyPair } from "../../src/cipher/namedCurve";
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

function buildChWithout1301(): Buffer {
  const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
  const curves = EllipticCurves.createEmpty();
  curves.data = [NamedCurveAlgorithm.x25519_29] as any;
  const ch = new ClientHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.alloc(0),
    // Deliberately omit 0x1301 — only a dummy TLS 1.2 suite
    [CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199],
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

function buildChWithLegacyCookie(): Buffer {
  const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
  const curves = EllipticCurves.createEmpty();
  curves.data = [NamedCurveAlgorithm.x25519_29] as any;
  const ch = new ClientHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.from([1, 2, 3, 4]), // non-empty legacy_cookie — illegal in DTLS 1.3
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

describe("e2e/self13 ClientHello validation", () => {
  test("rejects ClientHello without 0x1301 with handshake_failure", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act: inject CH without TLS_AES_128_GCM_SHA256
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("cipher suite reject timeout")),
        5_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(/handshake_failure|0x1301|TLS_AES/i);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(buildChWithout1301(), ["127.0.0.1", 9] as any);
    });
  }, 10_000);

  test("rejects non-empty legacy_cookie with illegal_parameter", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act / Assert
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("legacy_cookie reject timeout")),
        5_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(/illegal_parameter|legacy_cookie/i);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(buildChWithLegacyCookie(), [
        "127.0.0.1",
        9,
      ] as any);
    });
  }, 10_000);

  test("ServerHello uses zero-length session_id (no echo)", async () => {
    // Arrange: full self HS then inspect that we don't require session id match
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    const client = new DtlsClient({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act / Assert: connection succeeds with zero-length session id policy
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("session id timeout")),
        10_000,
      );
      client.onConnect.subscribe(() => {
        const eng = (server as any).engine13;
        expect(eng.sessionId.length).toBe(0);
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      await client.connect();
    });
  }, 15_000);
});
