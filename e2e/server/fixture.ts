import {
  DtlsKeys,
  HashAlgorithm,
  PeerConfig,
  SignatureAlgorithm,
  createSelfSignedCertificate,
} from ".";
import { BundlePolicy, NamedCurveAlgorithm } from "../../packages/webrtc/src";

export class DtlsKeysContext {
  private static rsa: DtlsKeys;
  private static ecdsa: DtlsKeys;

  static async get() {
    if (this.rsa) {
      return Math.random() > 0.5 ? this.rsa : this.ecdsa;
    }

    this.rsa = await createSelfSignedCertificate({
      signature: SignatureAlgorithm.rsa_1,
      hash: HashAlgorithm.sha256_4,
    });

    this.ecdsa = await createSelfSignedCertificate(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23,
    );
  }
}

export const peerConfig: Promise<Partial<PeerConfig>> = (async () => ({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  dtls: { keys: await DtlsKeysContext.get() },
  bundlePolicy: "max-bundle" as BundlePolicy,
}))();
