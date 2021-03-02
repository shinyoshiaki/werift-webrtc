import { DtlsServer, DtlsClient, createUdpTransport } from "../../src";
import { createSocket } from "dgram";
import { certPem, keyPem } from "../fixture";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";

test("e2e/self", (done) => {
  const word = "self";
  const port = 55557;
  const socket = createSocket("udp4");
  socket.bind(port);
  const server = new DtlsServer({
    cert: certPem,
    key: keyPem,
    signatureHash: {
      hash: HashAlgorithm.sha256,
      signature: SignatureAlgorithm.rsa,
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
      hash: HashAlgorithm.sha256,
      signature: SignatureAlgorithm.rsa,
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
}, 10_000);
