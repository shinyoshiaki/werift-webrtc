import { DtlsServer, DtlsClient, createUdpTransport } from "../../src";
import { readFileSync } from "fs";
import { createSocket } from "dgram";

test("e2e/self", (done) => {
  const word = "self";
  const port = 55557;
  const socket = createSocket("udp4");
  socket.bind(port);
  const server = new DtlsServer({
    cert: readFileSync("assets/cert.pem").toString(),
    key: readFileSync("assets/key.pem").toString(),
    transport: createUdpTransport(socket),
  });
  server.onData = (data) => {
    expect(data.toString()).toBe(word);
    server.send(Buffer.from(word + "_server"));
  };
  const client = new DtlsClient({
    transport: createUdpTransport(createSocket("udp4"), {
      address: "127.0.0.1",
      port,
    }),
  });
  client.onConnect = () => {
    client.send(Buffer.from(word));
  };
  client.onData = (data) => {
    expect(data.toString()).toBe(word + "_server");
    socket.close();
    done();
  };
  client.connect();
});
