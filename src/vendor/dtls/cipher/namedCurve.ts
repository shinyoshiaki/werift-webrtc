import { generateKeyPairSync } from "crypto";
import { ec } from "elliptic";
import * as nacl from "tweetnacl";
import { NamedCurveAlgorithm } from "./const";
const elliptic = new ec("secp256k1");

export const supportedCurves = [NamedCurveAlgorithm.namedCurveX25519];
export const supportedCurveFilter = (curves: number[]) =>
  curves.filter((curve) => supportedCurves.includes(curve));

export type NamedCurveKeyPair = {
  curve: number;
  publicKey: Buffer;
  privateKey: Buffer;
};

export function generateKeyPair(
  namedCurve: number
): NamedCurveKeyPair | undefined {
  switch (namedCurve) {
    case NamedCurveAlgorithm.namedCurveP256: {
      const key = elliptic.genKeyPair();
      const pub = key.getPublic();
      const byteLen = (256 + 7) >> 3;
      const publicKey = Buffer.alloc(byteLen * 2 + 1);
      Buffer.from([4]).copy(publicKey, 0);
      const xBytes = pub.getX().toBuffer();
      xBytes.copy(publicKey, 1 + byteLen - xBytes.length);
      const yBytes = pub.getY().toBuffer();
      yBytes.copy(publicKey, 1 + byteLen * 2 - yBytes.length);

      const privateKey = key.getPrivate().toBuffer();

      const res = generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      const testPub = res.publicKey.export({ type: "spki", format: "der" });
      const testPriv = res.privateKey.export({ type: "sec1", format: "der" });

      return {
        curve: namedCurve,
        privateKey,
        publicKey,
      };
    }
    case NamedCurveAlgorithm.namedCurveX25519: {
      const keys = nacl.box.keyPair();

      return {
        curve: namedCurve,
        privateKey: Buffer.from(keys.secretKey.buffer),
        publicKey: Buffer.from(keys.publicKey.buffer),
      };
    }
  }
}
