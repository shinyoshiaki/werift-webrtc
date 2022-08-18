import {
  createSelfSignedCertificate,
  DtlsKeys,
  HashAlgorithm,
  SignatureAlgorithm,
  PeerConfig,
} from ".";
import { BundlePolicy } from "../../packages/webrtc/src";

export class DtlsKeysContext {
  static keys: DtlsKeys;

  static async get() {
    if (this.keys) return this.keys;

    this.keys = await createSelfSignedCertificate({
      signature: SignatureAlgorithm.rsa_1,
      hash: HashAlgorithm.sha256_4,
    });
  }
}

export const peerConfig: Promise<Partial<PeerConfig>> = (async () => ({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  dtls: { keys: await DtlsKeysContext.get() },
  bundlePolicy: "max-bundle" as BundlePolicy,
}))();
