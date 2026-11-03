import { generateKeyPairSync } from "node:crypto";

import { NamedCurveAlgorithm, type NamedCurveAlgorithms } from "./const";
import { p256Keypair } from "./ec";

export interface NamedCurveKeyPair {
  curve: NamedCurveAlgorithms;
  publicKey: Buffer;
  privateKey: Buffer;
}

export function generateKeyPair(
  namedCurve: NamedCurveAlgorithms,
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
      const keys = generateKeyPairSync("x25519");
      const privateJwk = keys.privateKey.export({ format: "jwk" });
      const publicJwk = keys.publicKey.export({ format: "jwk" });

      return {
        curve: namedCurve,
        privateKey: Buffer.from(privateJwk.d!, "base64url"),
        publicKey: Buffer.from(publicJwk.x!, "base64url"),
      };
    }
    default:
      throw new Error();
  }
}
