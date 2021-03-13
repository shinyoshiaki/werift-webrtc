import { createDecode } from "binary-data";
import { createHash, createHmac } from "crypto";
import { ec } from "elliptic";
import * as nacl from "tweetnacl";
import { NamedCurveAlgorithm, NamedCurveAlgorithms } from "./const";

export function prfPreMasterSecret(
  publicKey: Buffer,
  privateKey: Buffer,
  curve: NamedCurveAlgorithms
) {
  switch (curve) {
    case NamedCurveAlgorithm.secp256r1:
      const elliptic = new ec("p256"); // aka secp256r1
      const pub = elliptic.keyFromPublic(publicKey).getPublic();
      const priv = elliptic.keyFromPrivate(privateKey).getPrivate();
      const res = pub.mul(priv);
      const secret = Buffer.from(res.encode("array", false)).slice(1, 33);
      return secret;
    case NamedCurveAlgorithm.x25519:
      return Buffer.from(nacl.scalarMult(privateKey, publicKey));
    default:
      throw new Error();
  }
}

export function hmac(algorithm: string, secret: Buffer, data: Buffer) {
  const hash = createHmac(algorithm, secret);
  hash.update(data);
  return hash.digest();
}

export function prfPHash(
  secret: Buffer,
  seed: Buffer,
  requestedLegth: number,
  algorithm = "sha256"
) {
  const totalLength = requestedLegth;
  const bufs: Buffer[] = [];
  let Ai = seed; // A0

  do {
    Ai = hmac(algorithm, secret, Ai); // A(i) = HMAC(secret, A(i-1))
    const output = hmac(algorithm, secret, Buffer.concat([Ai, seed]));

    bufs.push(output);
    requestedLegth -= output.length; // eslint-disable-line no-param-reassign
  } while (requestedLegth > 0);

  return Buffer.concat(bufs, totalLength);
}

export function prfMasterSecret(
  preMasterSecret: Buffer,
  clientRandom: Buffer,
  serverRandom: Buffer
) {
  const seed = Buffer.concat([
    Buffer.from("master secret"),
    clientRandom,
    serverRandom,
  ]);
  return prfPHash(preMasterSecret, seed, 48);
}

export function prfExtendedMasterSecret(
  preMasterSecret: Buffer,
  handshakes: Buffer
) {
  const sessionHash = hash("sha256", handshakes);
  const label = "extended master secret";
  return prfPHash(
    preMasterSecret,
    Buffer.concat([Buffer.from(label), sessionHash]),
    48
  );
}

export function exportKeyingMaterial(
  label: string,
  length: number,
  masterSecret: Buffer,
  localRandom: Buffer,
  remoteRandom: Buffer,
  isClient: boolean
) {
  const clientRandom = isClient ? localRandom : remoteRandom;
  const serverRandom = isClient ? remoteRandom : localRandom;
  const seed = Buffer.concat([Buffer.from(label), clientRandom, serverRandom]);
  return prfPHash(masterSecret, seed, length);
}

export function hash(algorithm: string, data: Buffer) {
  return createHash(algorithm).update(data).digest();
}

export function prfVerifyData(
  masterSecret: Buffer,
  handshakes: Buffer,
  label: string,
  size = 12
) {
  const bytes = hash("sha256", handshakes);
  return prfPHash(
    masterSecret,
    Buffer.concat([Buffer.from(label), bytes]),
    size
  );
}

export function prfVerifyDataClient(masterSecret: Buffer, handshakes: Buffer) {
  return prfVerifyData(masterSecret, handshakes, "client finished");
}

export function prfVerifyDataServer(masterSecret: Buffer, handshakes: Buffer) {
  return prfVerifyData(masterSecret, handshakes, "server finished");
}

export function prfEncryptionKeys(
  masterSecret: Buffer,
  clientRandom: Buffer,
  serverRandom: Buffer,
  prfKeyLen: number,
  prfIvLen: number,
  prfNonceLen: number,
  algorithm = "sha256"
) {
  const size = prfKeyLen * 2 + prfIvLen * 2;
  const secret = masterSecret;
  const seed = Buffer.concat([serverRandom, clientRandom]);
  const keyBlock = prfPHash(
    secret,
    Buffer.concat([Buffer.from("key expansion"), seed]),
    size,
    algorithm
  );
  const stream = createDecode(keyBlock);

  const clientWriteKey = stream.readBuffer(prfKeyLen);
  const serverWriteKey = stream.readBuffer(prfKeyLen);

  const clientNonceImplicit = stream.readBuffer(prfIvLen);
  const serverNonceImplicit = stream.readBuffer(prfIvLen);

  const clientNonce = Buffer.alloc(prfNonceLen, 0);
  const serverNonce = Buffer.alloc(prfNonceLen, 0);

  clientNonceImplicit.copy(clientNonce, 0);
  serverNonceImplicit.copy(serverNonce, 0);

  return { clientWriteKey, serverWriteKey, clientNonce, serverNonce };
}
