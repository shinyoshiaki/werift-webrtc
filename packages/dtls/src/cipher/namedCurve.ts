import { ec } from "elliptic";
import * as nacl from "tweetnacl";
import { NamedCurveAlgorithm } from "./const";

export type NamedCurveKeyPair = {
  curve: number;
  publicKey: Buffer;
  privateKey: Buffer;
};

export function generateKeyPair(namedCurve: number): NamedCurveKeyPair {
  switch (namedCurve) {
    case NamedCurveAlgorithm.secp256r1: {
      const elliptic = new ec("p256");
      const key = elliptic.genKeyPair();
      const privateKey = key.getPrivate().toBuffer("be");
      const publicKey = Buffer.from(key.getPublic().encode("array", false));

      return {
        curve: namedCurve,
        privateKey,
        publicKey,
      };
    }
    case NamedCurveAlgorithm.x25519: {
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
