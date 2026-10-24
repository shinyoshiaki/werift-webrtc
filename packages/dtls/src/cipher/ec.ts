import { createECDH } from "node:crypto";

export const p256Keypair = (): { privateKey: Buffer; publicKey: Buffer } => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey();
  const publicKey = ecdh.getPublicKey();

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
  return createECDH("prime256v1")
    .setPrivateKey(privateKey)
    .computeSecret(publicKey);
};
