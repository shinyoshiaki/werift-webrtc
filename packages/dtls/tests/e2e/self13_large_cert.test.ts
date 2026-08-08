import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";

const assets = join(__dirname, "../../assets");
const largeCertPem = readFileSync(join(assets, "large_cert.pem"), "utf8");
const largeKeyPem = readFileSync(join(assets, "large_key.pem"), "utf8");

describe("e2e/self13 large certificate full handshake", () => {
  test(
    "multi-KB X.509 cert: fragmentation + CertificateVerify + app data",
    async () => {
      // Arrange: real multi-KB X.509 (not random buffer codec-only test)
      expect(Buffer.from(largeCertPem).length).toBeGreaterThan(2000);

      const serverTransport = await UdpTransport.init("udp4");
      const clientTransport = await UdpTransport.init("udp4");
      clientTransport.rinfo = serverTransport.address;

      // Small MTU forces multi-record / fragment reassembly for Certificate
      const server = new DtlsServer({
        transport: serverTransport,
        cert: largeCertPem,
        key: largeKeyPem,
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
        mtu: 400,
      });
      const client = new DtlsClient({
        transport: clientTransport,
        cert: largeCertPem,
        key: largeKeyPem,
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
        mtu: 400,
      });

      // Act / Assert: full HS + CertificateVerify + bidirectional app data
      await new Promise<void>(async (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("large cert e2e timeout")),
          20_000,
        );
        let gotClient = false;
        let gotServer = false;
        const maybeDone = () => {
          if (gotClient && gotServer) {
            clearTimeout(timer);
            client.close();
            server.close();
            resolve();
          }
        };
        client.onConnect.subscribe(() => {
          void client.send(Buffer.from("large-cert-c2s"));
        });
        server.onConnect.subscribe(() => {
          void server.send(Buffer.from("large-cert-s2c"));
        });
        server.onData.subscribe((d) => {
          expect(d.toString()).toBe("large-cert-c2s");
          gotServer = true;
          maybeDone();
        });
        client.onData.subscribe((d) => {
          expect(d.toString()).toBe("large-cert-s2c");
          gotClient = true;
          maybeDone();
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
    },
    30_000,
  );
});
