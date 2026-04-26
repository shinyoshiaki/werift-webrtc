import { createSocket } from "dgram";

import { UdpTransport, randomPort } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

test(
  "e2e/self",
  async () =>
    new Promise<void>(async (done) => {
      const word = "self";

      const server = new DtlsServer({
        transport: await UdpTransport.init("udp4"),
        cert: certPem,
        key: keyPem,
        signatureHash: {
          hash: HashAlgorithm.sha256_4,
          signature: SignatureAlgorithm.rsa_1,
        },
      });
      const transport = await UdpTransport.init("udp4");
      transport.rinfo = server.transport.socket.address;
      const client = new DtlsClient({
        transport,
        cert: certPem,
        key: keyPem,
        signatureHash: {
          hash: HashAlgorithm.sha256_4,
          signature: SignatureAlgorithm.rsa_1,
        },
      });
      server.onData.subscribe((data) => {
        expect(data.toString()).toBe(word);
        server.send(Buffer.from(word + "_server"));
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
