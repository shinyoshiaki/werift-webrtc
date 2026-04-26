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
