import nodeCrypto from "crypto";
import * as x509 from "@peculiar/x509";

import {
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../src/cipher/const.js";
import { DtlsClient } from "../src/client.js";
import { CipherContext } from "../src/context/cipher.js";
import { UdpTransport } from "../../common/src/index.js";

const crypto = nodeCrypto.webcrypto;
x509.cryptoProvider.set(crypto as any);

(async () => {
  const { certPem, keyPem, signatureHash } =
    await CipherContext.createSelfSignedCertificateWithKey(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23,
    );
  const transport = await UdpTransport.init("udp4");
  transport.rinfo = {
    address: "127.0.0.1",
    port: 4444,
  };

  const client = new DtlsClient({
    cert: certPem,
    key: keyPem,
    signatureHash,
    transport,
    extendedMasterSecret: true,
  });
  client.onConnect.once(() =>
    setTimeout(() => client.send(Buffer.from("hello from client")), 500),
  );
  client.onData.subscribe((data) => console.log(data.toString()));
  client.connect();
})();
