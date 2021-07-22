import { createSocket } from "dgram";

import { createUdpTransport, DtlsServer } from "../src";
import { CipherSuite } from "../src/cipher/const";
import { ClientHello } from "../src/handshake/message/client/hello";
import { DtlsRandom } from "../src/handshake/random";

describe("server", () => {
  test("handleFragmentHandshake", () => {
    const server = new DtlsServer({
      transport: createUdpTransport(createSocket("udp4")),
      cert: "",
      key: "",
    });

    const hello = new ClientHello(
      { major: 255 - 1, minor: 255 - 2 },
      new DtlsRandom(),
      Buffer.from([]),
      Buffer.from([]),
      [
        CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
      ],
      [0], // don't compress
      []
    );

    const fragments = hello.toFragment().chunk(10);
    const last = fragments.pop()!;
    const second = fragments.pop()!;
    fragments.forEach((fragment) => server.handleFragmentHandshake([fragment]));
    expect(server.handleFragmentHandshake([last]).length).toBeGreaterThan(0);
    expect(server.handleFragmentHandshake([second]).length).toBe(0);
  });
});
