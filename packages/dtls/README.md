DTLS v1.2 server/client Implementation for TypeScript

# Example

```typescript
import { DtlsServer, DtlsClient, createUdpTransport } from "werift-dtls";
import { readFileSync } from "fs";
import { createSocket } from "dgram";

const port = 55557;

const socket = createSocket("udp4");
socket.bind(port);

const server = new DtlsServer({
  cert: readFileSync("assets/cert.pem").toString(),
  key: readFileSync("assets/key.pem").toString(),
  transport: createUdpTransport(socket),
});

const client = new DtlsClient({
  transport: createUdpTransport(createSocket("udp4"), {
    address: "127.0.0.1",
    port,
  }),
});

server.onData = (data) => {
  console.log(data.toString());
};

client.onConnect = () => {
  client.send(Buffer.from("ping"));
};
client.onData = (data) => {
  console.log(data.toString());
};

client.connect();
```

# reference

- RFC5246
- RFC6347
- pion/dtls https://github.com/pion/dtls
- nodertc/dtls https://github.com/nodertc/dtls
- node-dtls https://github.com/Rantanen/node-dtls
- node-dtls-client https://github.com/AlCalzone/node-dtls-client
- OpenSSL

# create key & cert

```sh
openssl genrsa 2048 > rsa.key
openssl pkcs8 -in rsa.key -topk8 -out key.pem -nocrypt
openssl req -new -key key.pem > cert.csr
openssl x509 -req -days 3650 -signkey key.pem -in cert.csr -out  cert.pem
```
