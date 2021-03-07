import { DtlsClient } from "../src/client";
import { createUdpTransport } from "../src";
import { createSocket } from "dgram";
import { CipherContext } from "../src/context/cipher";
import {
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../src/cipher/const";

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
  client.onConnect.once(() => client.send(Buffer.from("hello")));
  client.onData.subscribe((data) => console.log(data.toString()));
  client.connect();
})();

// openssl s_server -cert ./assets/cert.pem -key ./assets/key.pem -dtls1_2 -accept 127.0.0.1:4444 -state
