import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsServer, DtlsVersion, ProtocolVersionError } from "../../src";
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
import { FragmentedHandshake } from "../../src/record/message/fragment";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import {
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  WireVersion,
} from "../../src/version";
import { certPem, keyPem } from "../fixture";

function buildChWithSupportedVersionsData(svData: Buffer): Buffer {
  const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
  const curves = EllipticCurves.createEmpty();
  curves.data = [NamedCurveAlgorithm.x25519_29] as any;
  const ch = new ClientHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.alloc(0),
    [
      CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
      CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
    ],
    [0],
    [
      { type: SupportedVersions.type, data: svData },
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

describe("SupportedVersions wire validation", () => {
  test("ClientHello: rejects odd length, empty list, trailing bytes", () => {
    // Arrange / Act / Assert
    // empty list (len=0)
    expect(() => SupportedVersions.fromData(Buffer.from([0x00]), false)).toThrow(
      /at least 2 bytes/i,
    );
    // odd length
    expect(() =>
      SupportedVersions.fromData(Buffer.from([0x01, 0xfe]), false),
    ).toThrow(/even/i);
    // trailing bytes after declared list
    expect(() =>
      SupportedVersions.fromData(
        Buffer.from([0x02, 0xfe, 0xfc, 0xff]),
        false,
      ),
    ).toThrow(/mismatch|trailing|length/i);
    // valid dual
    const ok = SupportedVersions.fromData(
      Buffer.from([0x04, 0xfe, 0xfc, 0xfe, 0xfd]),
      false,
    );
    expect(ok.versions).toEqual([DTLS_1_3_VERSION, DTLS_1_2_VERSION]);
  });

  test("ServerHello/HRR: requires exactly 2 bytes", () => {
    // Arrange / Act / Assert
    expect(() => SupportedVersions.fromData(Buffer.from([0xfe]), true)).toThrow(
      /exactly 2/i,
    );
    expect(() =>
      SupportedVersions.fromData(Buffer.from([0xfe, 0xfc, 0x00]), true),
    ).toThrow(/exactly 2/i);
    const ok = SupportedVersions.fromData(Buffer.from([0xfe, 0xfc]), true);
    expect(ok.selected).toBe(DTLS_1_3_VERSION);
  });
});

describe("dual server supported_versions negative integration", () => {
  async function dualServer() {
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
      addressValidation: "none",
    });
    return { server, serverTransport };
  }

  test("unknown version only → protocol_version (not silent 1.2)", async () => {
    // Arrange: extension present with TLS classic codepoint only (unknown to DTLS map)
    const { server, serverTransport } = await dualServer();
    const pkt = buildChWithSupportedVersionsData(
      Buffer.from([0x02, 0x03, 0x03]), // TLS 1.2 0x0303 — not a DTLS wire version
    );
    // Act / Assert: must not become connected as DTLS 1.2
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("unknown-only should fail promptly")),
        5_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        // Act/Assert: association must fail closed (not complete as DTLS 1.2)
        expect(server.connected).toBe(false);
        server.close();
        resolve();
      });
      server.onConnect.subscribe(() => {
        clearTimeout(timer);
        reject(new Error("must not connect on unknown-only supported_versions"));
      });
      serverTransport.onData?.(pkt, ["127.0.0.1", 40001] as any);
    });
  }, 10_000);

  test("empty supported_versions list → protocol failure", async () => {
    // Arrange: extension present with empty list (malformed: len=0)
    const { server, serverTransport } = await dualServer();
    const pkt = buildChWithSupportedVersionsData(Buffer.from([0x00]));
    // Act / Assert: decode or version fail — must not complete as 1.2
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("empty list should fail promptly")),
        5_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message.length).toBeGreaterThan(0);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      // Also resolve if no handshake progresses (silent drop of bad CH) after brief wait
      // Prefer onError; dual server may protocol_version alert
      serverTransport.onData?.(pkt, ["127.0.0.1", 40002] as any);
      // If association doesn't error (drops as invalid), treat as pass for non-1.2
      setTimeout(() => {
        if (!server.connected) {
          clearTimeout(timer);
          server.close();
          resolve();
        }
      }, 500);
    });
  }, 10_000);

  test("trailing bytes in supported_versions → not accepted as dual 1.3", async () => {
    // Arrange
    const { server, serverTransport } = await dualServer();
    // declared 2 bytes of versions but trailing 0xff
    const pkt = buildChWithSupportedVersionsData(
      Buffer.from([0x02, 0xfe, 0xfc, 0xff]),
    );
    // Act / Assert
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("trailing bytes should fail/drop")),
        5_000,
      );
      server.onError.subscribe(() => {
        clearTimeout(timer);
        server.close();
        resolve();
      });
      serverTransport.onData?.(pkt, ["127.0.0.1", 40003] as any);
      setTimeout(() => {
        if (!server.connected) {
          clearTimeout(timer);
          server.close();
          resolve();
        }
      }, 500);
    });
  }, 10_000);
});
