import { createSocket } from "dgram";

import { UdpTransport, randomPort } from "../../../../common/src";
import { DtlsClient, DtlsServer } from "../../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../../src/cipher/const";
import { certPem, keyPem } from "../../fixture";

test(
  "e2e/certificate_request/self",
  async () =>
    new Promise<void>(async (done) => {
      const word = "self";
      const port = await randomPort();

      const server = new DtlsServer({
        cert: certPem,
        key: keyPem,
        signatureHash: {
          hash: HashAlgorithm.sha256_4,
          signature: SignatureAlgorithm.rsa_1,
        },
        transport: await UdpTransport.init("udp4", { port }),
        certificateRequest: true,
      });
      server.onData.subscribe((data) => {
        expect(data.toString()).toBe(word);
        server.send(Buffer.from(word + "_server"));
      });
      const transport = await UdpTransport.init("udp4");
      transport.rinfo = {
        address: "127.0.0.1",
        port,
      };
      const client = new DtlsClient({
        transport,
        cert: certPem,
        key: keyPem,
        signatureHash: {
          hash: HashAlgorithm.sha256_4,
          signature: SignatureAlgorithm.rsa_1,
        },
      });
      client.onConnect.subscribe(() => {
        client.send(Buffer.from(word));
      });
      client.onData.subscribe((data) => {
        expect(data.toString()).toBe(word + "_server");
        done();
      });
      client.connect();
    }),
  10_000,
);
