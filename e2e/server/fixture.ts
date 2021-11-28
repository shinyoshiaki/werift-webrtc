import {
  createSelfSignedCertificate,
  DtlsKeys,
  HashAlgorithm,
  SignatureAlgorithm,
} from ".";

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
