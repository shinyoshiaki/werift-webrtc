import { Certificate, PrivateKey } from "@fidm/x509";
import { encode, types } from "binary-data";

export function parseX509(certPem: string, keyPem: string) {
  const cert = Certificate.fromPEM(Buffer.from(certPem));
  const sec = PrivateKey.fromPEM(Buffer.from(keyPem));
  return { key: sec, cert: cert.raw };
}

export function generateKeySignature(
  clientRandom: Buffer,
  serverRandom: Buffer,
  publicKey: Buffer,
  namedCurve: number,
  privateKey: PrivateKey,
  hashAlgorithm: string
) {
  const sig = valueKeySignature(
    clientRandom,
    serverRandom,
    publicKey,
    namedCurve
  );

  const enc = privateKey.sign(sig, hashAlgorithm);
  return enc;
}

function valueKeySignature(
  clientRandom: Buffer,
  serverRandom: Buffer,
  publicKey: Buffer,
  namedCurve: number
) {
  const serverParams = Buffer.from(
    encode(
      { type: 3, curve: namedCurve, len: publicKey.length },
      { type: types.uint8, curve: types.uint16be, len: types.uint8 }
    ).slice()
  );
  return Buffer.concat([clientRandom, serverRandom, serverParams, publicKey]);
}
