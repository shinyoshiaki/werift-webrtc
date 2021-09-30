import { Crypto } from "@peculiar/webcrypto";
import * as x509 from "@peculiar/x509";
import { createSocket } from "dgram";

import { createUdpTransport } from "../src";
import {
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../src/cipher/const";
import { DtlsClient } from "../src/client";
import { CipherContext } from "../src/context/cipher";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto as any);

(async () => {
  const { certPem, keyPem, signatureHash } =
    await CipherContext.createSelfSignedCertificateWithKey(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23
    );
  const client = new DtlsClient({
    cert: certPem,
    key: keyPem,
    signatureHash,
    transport: createUdpTransport(createSocket("udp4"), {
      address: "127.0.0.1",
      port: 4444,
    }),
    extendedMasterSecret: true,
  });
  client.onConnect.once(() =>
    setTimeout(() => client.send(Buffer.from("hello from client")), 500)
  );
  client.onData.subscribe((data) => console.log(data.toString()));
  client.connect();
})();
