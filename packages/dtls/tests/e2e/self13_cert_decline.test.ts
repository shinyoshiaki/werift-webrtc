import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { certPem, keyPem } from "../fixture";

describe("e2e/self13 client cert decline", () => {
  test("client without cert sends empty Certificate; server rejects with certificate_required", async () => {
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
      certificateRequest: true,
    });
    const client = new DtlsClient({
      transport: clientTransport,
      // no cert/key — TLS 1.3 empty Certificate decline path
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });

    // Act / Assert: 証明書・署名を検証する
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("empty cert decline timeout")),
        12_000,
      );
      let done = false;
      const finish = (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Server (or client after certificate_required alert) must fail
        expect(
          /certificate_required|Certificate|mutual auth|fatal alert/i.test(
            e.message,
          ),
        ).toBe(true);
        client.close();
        server.close();
        resolve();
      };
      // Policy lives on server; client may markConnected before server rejects
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
