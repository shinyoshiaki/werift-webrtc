import { spawn } from "child_process";
import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

/**
 * OpenSSL DTLS 1.2 regression for dual-stack client:
 * protocolVersions = [V1_3, V1_2] × openssl s_server -dtls1_2
 */
describe("e2e/client dual fallback openssl", () => {
  test("werift [1.3,1.2] client connects to openssl -dtls1_2", async () => {
    // Arrange: 前提を準備する
    const port = 55561;
    const args = [
      "s_server",
      "-cert",
      "./assets/cert.pem",
      "-key",
      "./assets/key.pem",
      "-dtls1_2",
      "-accept",
      `127.0.0.1:${port}`,
    ];
    const openssl = spawn("openssl", args, { cwd: process.cwd() });
    openssl.stdout?.setEncoding("ascii");

    await new Promise((r) => setTimeout(r, 150));

    const transport = await UdpTransport.init("udp4");
    transport.rinfo = { address: "127.0.0.1", port };
    const client = new DtlsClient({
      transport,
      cert: certPem,
      key: keyPem,
      signatureHash: {
        hash: HashAlgorithm.sha256_4,
        signature: SignatureAlgorithm.rsa_1,
      },
      protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    });

    // Act / Assert: ハンドシェイクを検証する
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("openssl dual fallback timeout"));
      }, 12_000);
      client.onConnect.subscribe(() => {
        expect(client.isDtls13).toBe(false);
        void client.send(Buffer.from("dual-openssl-12"));
      });
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      openssl.stdout?.on("data", (data: string) => {
        if (data.includes("dual-openssl-12")) {
          clearTimeout(timer);
          resolve();
        }
      });
      void client.connect().catch(reject);
    }).finally(() => {
      client.close();
      openssl.kill("SIGTERM");
      void transport.close();
    });
  }, 20_000);

  test("werift 1.2 client EXTRACTOR-dtls_srtp still works with openssl", async () => {
    // Arrange: 前提を準備する
    const port = 55562;
    const args = [
      "s_server",
      "-cert",
      "./assets/cert.pem",
      "-key",
      "./assets/key.pem",
      "-dtls1_2",
      "-accept",
      `127.0.0.1:${port}`,
      "-use_srtp",
      "SRTP_AES128_CM_SHA1_80",
    ];
    const openssl = spawn("openssl", args, { cwd: process.cwd() });
    await new Promise((r) => setTimeout(r, 150));

    const transport = await UdpTransport.init("udp4");
    transport.rinfo = { address: "127.0.0.1", port };
    const client = new DtlsClient({
      transport,
      cert: certPem,
      key: keyPem,
      signatureHash: {
        hash: HashAlgorithm.sha256_4,
        signature: SignatureAlgorithm.rsa_1,
      },
      protocolVersions: [DtlsVersion.V1_2],
      srtpProfiles: [0x0001],
    });

    // Act / Assert: use_srtp/MKI を検証する
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("srtp 1.2 openssl timeout")),
        12_000,
      );
      client.onConnect.subscribe(() => {
        try {
          const material = client.exportKeyingMaterial(
            "EXTRACTOR-dtls_srtp",
            60,
          );
          expect(material.length).toBe(60);
          clearTimeout(timer);
          resolve();
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      void client.connect().catch(reject);
    }).finally(() => {
      client.close();
      openssl.kill("SIGTERM");
      void transport.close();
    });
  }, 20_000);
});

/**
 * OpenSSL DTLS 1.2 regression for dual-stack server:
 * openssl s_client -dtls1_2 → werift [V1_3, V1_2] server
 */
describe("e2e/server dual fallback openssl", () => {
  test("openssl -dtls1_2 client connects to werift [1.3,1.2] server", async () => {
    // Arrange
    const transport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport,
      cert: certPem,
      key: keyPem,
      signatureHash: {
        hash: HashAlgorithm.sha256_4,
        signature: SignatureAlgorithm.rsa_1,
      },
      protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    });

    const openssl = spawn("openssl", [
      "s_client",
      "-dtls1_2",
      "-connect",
      `127.0.0.1:${transport.port}`,
    ]);
    openssl.stdout?.setEncoding("ascii");

    // Act / Assert: 1.3 preferred server が 1.2-only OpenSSL に fallback
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("openssl s_client dual server fallback timeout"));
        }, 15_000);
        server.onConnect.subscribe(() => {
          expect(server.isDtls13).toBe(false);
          expect(server.connected).toBe(true);
          void server.send(Buffer.from("dual-openssl-12-server"));
        });
        server.onError.subscribe((e) => {
          clearTimeout(timer);
          reject(e);
        });
        openssl.stdout?.on("data", (data: string) => {
          if (data.includes("dual-openssl-12-server")) {
            clearTimeout(timer);
            resolve();
          }
        });
        openssl.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    } finally {
      openssl.kill("SIGTERM");
      try {
        server.close();
      } catch {
        /* */
      }
      await transport.close().catch(() => {});
    }
  }, 20_000);
});
