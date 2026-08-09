import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import {
  DtlsClient,
  DtlsServer,
  DtlsVersion,
} from "../../../src";
import { CipherSuite, NamedCurveAlgorithm } from "../../../src/cipher/const";
import { generateKeyPair } from "../../../src/cipher/namedCurve";
import { CookieExtension } from "../../../src/handshake/extensions/cookie";
import { EllipticCurves } from "../../../src/handshake/extensions/ellipticCurves";
import { KeyShare } from "../../../src/handshake/extensions/keyShare";
import {
  SignatureAlgorithms,
  SignatureScheme13,
} from "../../../src/handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../../src/handshake/extensions/supportedVersions";
import { ClientHello } from "../../../src/handshake/message/client/hello";
import { CertificateVerify13 } from "../../../src/handshake/message/tls13/certificateVerify";
import { DtlsRandom } from "../../../src/handshake/random";
import { ContentType } from "../../../src/record/const";
import { serializePlaintextRecord } from "../../../src/record/v1_3/record";
import { DTLS_1_3_VERSION, WireVersion } from "../../../src/version";
import {
  certPem,
  ecdsaP256CertPem,
  ecdsaP256KeyPem,
  keyPem,
} from "../../fixture";

function buildCh(opts?: {
  compression?: number[];
  keyExchange?: Buffer;
  group?: number;
}): Buffer {
  const group = opts?.group ?? NamedCurveAlgorithm.x25519_29;
  const kp =
    opts?.keyExchange != null
      ? { publicKey: opts.keyExchange }
      : generateKeyPair(group as any);
  const curves = EllipticCurves.createEmpty();
  curves.data = [group] as any;
  const ch = new ClientHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.alloc(0),
    [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
    opts?.compression ?? [0],
    [
      SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension,
      curves.extension,
      KeyShare.forClient([
        { group, keyExchange: kp.publicKey as Buffer },
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

describe("P1: pre-cookie malformed CH must not kill association", () => {
  test("A→valid CH, B→parseable malformed CH, A completes handshake", async () => {
    // Arrange: dtls-cookie server; B sends compression=[0,1] CH while A is mid-HRR
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;

    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "dtls-cookie",
    });
    const client = new DtlsClient({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "dtls-cookie",
    });

    // Act / Assert: B の不正 CH 後も A が cookie 経路で完走する
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("pre-cookie DoS regression timeout")),
        20_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(
          new Error(
            `server must not fail from unvalidated B: ${e.message}`,
          ),
        );
      });
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });

      // Start A
      void client.connect();
      // Shortly after, inject B's parseable-but-illegal CH (bad compression)
      await new Promise((r) => setTimeout(r, 30));
      const bad = buildCh({ compression: [0, 1] });
      serverTransport.onData?.(bad, ["203.0.113.99", 4444] as any);
      await new Promise((r) => setTimeout(r, 20));
    });
  }, 25_000);
});

describe("P2: authenticated wrong-order handshake is fatal", () => {
  test("server epoch-2 EncryptedExtensions reaches state machine (unexpected_message)", async () => {
    // Arrange: complete HS then inject wrong type via engine dispatch path
    // (full AEAD path is covered by isAllowedHandshake change + state machine)
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

    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("setup timeout")),
        12_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.onConnect.subscribe(async () => {
        try {
          const eng = (server as any).engine13;
          // Act: epoch 2 EE on server (wrong role) via processHandshakeBytes
          // Use nextReceiveSeq so it is not treated as a retransmit/dup.
          const seq = eng.nextReceiveSeq ?? 0;
          const body = Buffer.from([0x00, 0x00]); // empty extensions
          const hdr = Buffer.alloc(12);
          hdr.writeUInt8(8, 0); // encrypted_extensions
          hdr.writeUIntBE(body.length, 1, 3);
          hdr.writeUInt16BE(seq, 4);
          hdr.writeUIntBE(0, 6, 3);
          hdr.writeUIntBE(body.length, 9, 3);
          // Assert: state machine が unexpected_message で fail
          await expect(
            eng.processHandshakeBytes(Buffer.concat([hdr, body]), 2),
          ).rejects.toThrow(/unexpected_message/i);
          clearTimeout(timer);
          client.close();
          server.close();
          resolve();
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
      await client.connect();
    });
  }, 15_000);
});

describe("P2: invalid key_share is illegal_parameter (not timeout)", () => {
  test("all-zero X25519 ClientHello key_share fails promptly after cookie", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none", // prompt failure after CH accepted
    });

    const zero = Buffer.alloc(32, 0);
    const probe = buildCh({ keyExchange: zero });

    // Act / Assert: all-zero は illegal_parameter で即 fail
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("all-zero key_share should fail promptly")),
        5_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(
            /illegal_parameter|all-zero|key_share|ECDH/i,
          );
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(probe, ["127.0.0.1", 9] as any);
    });
  }, 8_000);
});

describe("P2: CertificateRequest scheme mismatch declines with empty Certificate", () => {
  test("RSA client + ECDSA-only CertificateRequest → empty cert then server certificate_required", async () => {
    // Arrange: server mutual-auth but only advertises ECDSA in CR via patch
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;

    const server = new DtlsServer({
      transport: serverTransport,
      cert: ecdsaP256CertPem,
      key: ecdsaP256KeyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      certificateRequest: true,
    });
    // RSA client cert
    const client = new DtlsClient({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });

    // CR の signature_algorithms を ECDSA のみに制限（RSA client は empty Certificate）
    const eng = (server as any).engine13;
    eng.localOfferedSignatureSchemes = [
      SignatureScheme13.ecdsa_secp256r1_sha256,
    ];

    // Act / Assert: client declines (empty cert); server policy rejects
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("scheme mismatch decline timeout")),
        12_000,
      );
      let done = false;
      const finish = (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        expect(
          /certificate_required|Certificate|mutual auth|fatal alert/i.test(
            e.message,
          ),
        ).toBe(true);
        client.close();
        server.close();
        resolve();
      };
      server.onError.subscribe(finish);
      client.onError.subscribe(finish);
      try {
        await client.connect();
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }, 15_000);
});

describe("P2/P3: strict cookie and CertificateVerify codecs", () => {
  test("CookieExtension rejects empty and trailing bytes", () => {
    // Arrange / Act / Assert: 空 cookie と trailing を拒否
    expect(() => CookieExtension.fromData(Buffer.from([0x00, 0x00]))).toThrow(
      /empty/i,
    );
    const good = CookieExtension.fromData(
      Buffer.from([0x00, 0x02, 0xaa, 0xbb]),
    );
    expect(good.cookie.equals(Buffer.from([0xaa, 0xbb]))).toBe(true);
    expect(() =>
      CookieExtension.fromData(Buffer.from([0x00, 0x02, 0xaa, 0xbb, 0xff])),
    ).toThrow(/length mismatch/i);
  });

  test("CertificateVerify13 rejects trailing bytes", () => {
    // Arrange
    const body = Buffer.alloc(6);
    body.writeUInt16BE(0x0804, 0);
    body.writeUInt16BE(1, 2);
    body[4] = 0x01;
    body[5] = 0xff; // trailing
    // Act / Assert
    expect(() => CertificateVerify13.deSerialize(body)).toThrow(
      /length mismatch/i,
    );
  });
});
