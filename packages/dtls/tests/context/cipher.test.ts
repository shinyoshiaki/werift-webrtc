import { X509Certificate } from "node:crypto";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { SessionType } from "../../src/cipher/suites/abstract";
import { CipherContext, normalizePem } from "../../src/context/cipher";
import { certPem, keyPem } from "../fixture";
import { indentPem } from "../utils";

describe("context/cipher", () => {
  test("parseX509 accepts indented PEM", () => {
    // Arrange
    const signatureHash = {
      signature: SignatureAlgorithm.rsa_1,
      hash: HashAlgorithm.sha256_4,
    };

    // Act: 各行がインデントされた証明書と秘密鍵で CipherContext を作る
    const context = new CipherContext(
      SessionType.SERVER,
      indentPem(certPem),
      indentPem(keyPem),
      signatureHash,
    );

    // Assert: インデントなしの PEM と同じ証明書・鍵として扱われる
    expect(context.localCert).toEqual(new X509Certificate(certPem).raw);
    expect(context.localPrivateKey?.asymmetricKeyType).toBe("rsa");
  });

  test("normalizePem trims indentation and blank lines", () => {
    // Act: インデントと空行を含む PEM を正規化する
    const normalized = normalizePem(`\n  ${indentPem(certPem)}\n\n`);

    // Assert: 行頭・行末の空白と空行が除かれ、末尾は改行 1 つになる
    expect(normalized).toBe(`${certPem.trim()}\n`);
  });
});
