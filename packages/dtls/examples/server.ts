import { Crypto } from "@peculiar/webcrypto";
import * as x509 from "@peculiar/x509";
import { createSocket } from "dgram";

import { createUdpTransport } from "../src";
import {
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../src/cipher/const";
import { CipherContext } from "../src/context/cipher";
import { DtlsServer } from "../src/server";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto as any);

const port = 4444;
const socket = createSocket("udp4");
socket.bind(port);

console.log("start");

(async () => {
  const { certPem, keyPem, signatureHash } =
    await CipherContext.createSelfSignedCertificateWithKey(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23
    );
  const server = new DtlsServer({
    transport: createUdpTransport(socket),
    extendedMasterSecret: true,
    cert: certPem,
    key: keyPem,
    signatureHash,
  });

  server.onData.subscribe((data) => console.log(data.toString()));
  server.onConnect.once(() =>
    setTimeout(() => server.send(Buffer.from("hello from server")), 1000)
  );
})();
