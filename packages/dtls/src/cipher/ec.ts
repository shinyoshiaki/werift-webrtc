import { ec } from "elliptic";
import { p256 } from "@noble/curves/p256";

export const p256Keypair = (): { privateKey: Buffer; publicKey: Buffer } => {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  const privateKey = Buffer.from(priv);
  const publicKey = Buffer.from(pub);

  return {
    privateKey,
    publicKey,
  };
};

export const old_p256Keypair = (): {
  privateKey: Buffer;
  publicKey: Buffer;
} => {
  const elliptic = new ec("p256");
  const key = elliptic.genKeyPair();
  const privateKey = key.getPrivate().toBuffer("be");
  const publicKey = Buffer.from(key.getPublic().encode("array", false));

  return {
    privateKey,
    publicKey,
  };
};

export const p256PreMasterSecret = ({
  publicKey,
  privateKey,
}: {
  publicKey: Buffer;
  privateKey: Buffer;
}): Buffer => {
  const res = p256.getSharedSecret(privateKey, publicKey);
  const secret = Buffer.from(res).subarray(1);

  return secret;
};

export const old_p256PreMasterSecret = ({
  publicKey,
  privateKey,
}: {
  publicKey: Buffer;
  privateKey: Buffer;
}): Buffer => {
  const elliptic = new ec("p256"); // aka secp256r1
  const pub = elliptic.keyFromPublic(publicKey).getPublic();
  const priv = elliptic.keyFromPrivate(privateKey).getPrivate();
  const res = pub.mul(priv);
  const secret = Buffer.from(res.encode("array", false)).subarray(1, 33);

  return secret;
};
