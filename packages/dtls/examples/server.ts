import { DtlsServer } from "../src/server";
import { createSocket } from "dgram";
import { createUdpTransport } from "../src";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

const port = 6666;
const socket = createSocket("udp4");
socket.bind(port);

(async () => {
  const alg = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test",
    notBefore: new Date("2020/01/01"),
    notAfter: new Date("2020/01/02"),
    signingAlgorithm: alg,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 2, true),
      new x509.ExtendedKeyUsageExtension(
        ["1.2.3.4.5.6.7", "2.3.4.5.6.7.8"],
        true
      ),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  const key = await exportCryptoKey(keys.privateKey);
  console.log(cert.toString());
  const server = new DtlsServer({
    cert: cert.toString(),
    key,
    transport: createUdpTransport(socket),
    extendedMasterSecret: true,
  });
  server.onData.subscribe((data) => console.log(data.toString()));
  server.onConnect.once(() => server.send(Buffer.from("hello")));
})();

// openssl s_client -dtls1_2 -connect 127.0.0.1:6666 -state

async function exportCryptoKey(key: CryptoKey) {
  const exported = Buffer.from(await crypto.subtle.exportKey("pkcs8", key));
  const exportedAsBase64 = exported.toString("base64");
  const pemExported = `-----BEGIN PRIVATE KEY-----\n${exportedAsBase64}\n-----END PRIVATE KEY-----`;

  return pemExported;
}
