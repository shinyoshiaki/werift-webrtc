import { DtlsServer } from "../src/server";
import { createSocket } from "dgram";
import { createUdpTransport } from "../src";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";
import { CipherContext } from "../src/context/cipher";
import {
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../src/cipher/const";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

const port = 6666;
const socket = createSocket("udp4");
socket.bind(port);

console.log("start");

(async () => {
  const {
    certPem,
    keyPem,
    signatureHash,
  } = await CipherContext.createSelfSignedCertificateWithKey(
    {
      signature: SignatureAlgorithm.ecdsa,
      hash: HashAlgorithm.sha256,
    },
    NamedCurveAlgorithm.secp256r1
  );
  const server = new DtlsServer({
    transport: createUdpTransport(socket),
    extendedMasterSecret: true,
    cert: certPem,
    key: keyPem,
    signatureHash,
  });

  server.onData.subscribe((data) => console.log(data.toString()));
  server.onConnect.once(() => server.send(Buffer.from("hello")));
})();

// openssl s_client -dtls1_2 -connect 127.0.0.1:6666 -state
