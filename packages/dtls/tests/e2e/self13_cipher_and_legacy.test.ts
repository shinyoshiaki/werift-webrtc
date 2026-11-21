import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { CipherSuite } from "../../src/cipher/const";
import { build13ClientHelloRecord, certPem, keyPem } from "../fixture";

describe("e2e/self13 ClientHello validation", () => {
  test("rejects ClientHello without 0x1301 with handshake_failure", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act: ハンドシェイクを検証する
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
      serverTransport.onData?.(
        build13ClientHelloRecord({
          // Deliberately omit 0x1301 — only a dummy TLS 1.2 suite
          cipherSuites: [
            CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
          ],
        }),
        ["127.0.0.1", 9] as any,
      );
    });
  }, 10_000);

  test("rejects non-empty legacy_cookie with illegal_parameter", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act / Assert: cookie 経路を検証する
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
      serverTransport.onData?.(
        build13ClientHelloRecord({
          // non-empty legacy_cookie — illegal in DTLS 1.3
          legacyCookie: Buffer.from([1, 2, 3, 4]),
        }),
        ["127.0.0.1", 9] as any,
      );
    });
  }, 10_000);

  test("rejects ClientHello with wrong legacy_version", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act / Assert: version 交渉を検証する
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("legacy_version reject timeout")),
        5_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(/illegal_parameter|legacy_version|0xfefd/i);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(
        build13ClientHelloRecord({
          legacyVersion: { major: 254, minor: 255 }, // not 0xfefd
        }),
        ["127.0.0.1", 9] as any,
      );
    });
  }, 10_000);

  test("rejects ClientHello with non-[0] compression_methods", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act / Assert: 不正入力を拒否する
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("compression reject timeout")),
        5_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(/illegal_parameter|compression_methods/i);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(
        build13ClientHelloRecord({
          compression: [0, 1], // must be exactly [0]
        }),
        ["127.0.0.1", 9] as any,
      );
    });
  }, 10_000);

  test("ServerHello uses zero-length session_id (no echo)", async () => {
    // Arrange: 前提を準備する
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
    // Act / Assert: 期待どおりの結果を検証する
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
