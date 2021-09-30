import { createSocket } from "dgram";

import { randomPort } from "../../../ice/src/utils";
import { createUdpTransport, DtlsClient, DtlsServer } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { certPem, keyPem } from "../fixture";

test(
  "e2e/self",
  async () =>
    new Promise<void>(async (done) => {
      const word = "self";
      const port = await randomPort();
      const socket = createSocket("udp4");
      socket.bind(port);
      const server = new DtlsServer({
        cert: certPem,
        key: keyPem,
        signatureHash: {
          hash: HashAlgorithm.sha256_4,
          signature: SignatureAlgorithm.rsa_1,
        },
        transport: createUdpTransport(socket),
      });
      const client = new DtlsClient({
        transport: createUdpTransport(createSocket("udp4"), {
          address: "127.0.0.1",
          port,
        }),
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
  10_000
);
