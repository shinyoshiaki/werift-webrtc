import { DtlsServer, DtlsClient, createUdpTransport } from "../../src";
import { createSocket } from "dgram";
import { certPem, keyPem } from "../fixture";

test("e2e/self", (done) => {
  const word = "self";
  const port = 55557;
  const socket = createSocket("udp4");
  socket.bind(port);
  const server = new DtlsServer({
    cert: certPem,
    key: keyPem,
    transport: createUdpTransport(socket),
  });
  const client = new DtlsClient({
    transport: createUdpTransport(createSocket("udp4"), {
      address: "127.0.0.1",
      port,
    }),
    cert: certPem,
    key: keyPem,
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
    socket.close();
    done();
  });
  client.connect();
});
