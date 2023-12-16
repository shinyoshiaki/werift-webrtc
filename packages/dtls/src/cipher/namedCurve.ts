import nacl from "tweetnacl";

import { NamedCurveAlgorithm, NamedCurveAlgorithms } from "./const";
import { p256Keypair } from "./ec";

export interface NamedCurveKeyPair {
  curve: NamedCurveAlgorithms;
  publicKey: Buffer;
  privateKey: Buffer;
}

export function generateKeyPair(
  namedCurve: NamedCurveAlgorithms
): NamedCurveKeyPair {
  switch (namedCurve) {
    case NamedCurveAlgorithm.secp256r1_23: {
      const { privateKey, publicKey } = p256Keypair();

      return {
        curve: namedCurve,
        privateKey,
        publicKey,
      };
    }
    case NamedCurveAlgorithm.x25519_29: {
      const keys = nacl.box.keyPair();

      return {
        curve: namedCurve,
        privateKey: Buffer.from(keys.secretKey.buffer),
        publicKey: Buffer.from(keys.publicKey.buffer),
      };
    }
    default:
      throw new Error();
  }
}
