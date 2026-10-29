import { createPrivateKey, X509Certificate } from "node:crypto";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { SessionType } from "../../src/cipher/suites/abstract";
import { createSelfSignedCertificatePem } from "../../src/context/certificate";
import { CipherContext } from "../../src/context/cipher";
import { createCertificateKeyPair } from "../utils";

describe("context/certificate", () => {
  test.each([
    ["ecdsa", SignatureAlgorithm.ecdsa_3, "ec", "2a8648ce3d040302"],
    ["rsa", SignatureAlgorithm.rsa_1, "rsa", "2a864886f70d01010b"],
  ] as const)(
    "createSelfSignedCertificateWithKey (%s) creates a valid self-signed certificate",
    async (_, signature, keyType, signatureOidHex) => {
      // Arrange
      const before = Date.now();

      // Act: 自己署名証明書と秘密鍵を生成し、node:crypto で読み込む
      const { certPem, keyPem, signatureHash } =
        await CipherContext.createSelfSignedCertificateWithKey({
          signature,
          hash: HashAlgorithm.sha256_4,
        });
      const cert = new X509Certificate(certPem);
      const privateKey = createPrivateKey(keyPem);

      // Assert: 発行者 = 主体で、証明書自身の公開鍵で署名を検証できる
      expect(cert.subject).toBe(
        "C=AU\nST=Some-State\nO=Internet Widgits Pty Ltd",
      );
      expect(cert.issuer).toBe(cert.subject);
      expect(cert.verify(cert.publicKey)).toBe(true);
      // Assert: 秘密鍵が証明書の公開鍵と対になり、鍵種別が署名方式と一致する
      expect(cert.checkPrivateKey(privateKey)).toBe(true);
      expect(privateKey.asymmetricKeyType).toBe(keyType);
      expect(signatureHash).toEqual({
        signature,
        hash: HashAlgorithm.sha256_4,
      });
      // Assert: 有効期間は生成時刻から約 10 年
      const validFrom = new Date(cert.validFrom).getTime();
      const validTo = new Date(cert.validTo).getTime();
      expect(validFrom).toBeGreaterThanOrEqual(
        Math.floor(before / 1000) * 1000,
      );
      expect(validTo - validFrom).toBe(10 * 365 * 24 * 60 * 60 * 1000);
      // Assert: 署名アルゴリズムの OID（ecdsa-with-SHA256 / sha256WithRSAEncryption）が証明書に含まれる
      expect(cert.raw.includes(Buffer.from(signatureOidHex, "hex"))).toBe(true);
    },
  );

  test("createSelfSignedCertificateWithKey can complete parseX509", async () => {
    // Arrange
    const { certPem, keyPem, signatureHash } =
      await CipherContext.createSelfSignedCertificateWithKey({
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      });

    // Act: 生成した PEM を CipherContext に読み込ませる
    const context = new CipherContext(
      SessionType.SERVER,
      certPem,
      keyPem,
      signatureHash,
    );

    // Assert: DER の証明書と KeyObject の秘密鍵として保持される
    expect(context.localCert).toEqual(new X509Certificate(certPem).raw);
    expect(context.localPrivateKey.asymmetricKeyType).toBe("ec");
  });

  test("createSelfSignedCertificatePem keeps the serial number positive and encodes post-2049 dates", () => {
    // Arrange
    const { publicKey, privateKey } = createCertificateKeyPair("ec");

    // Act: 最上位ビットが立ったシリアル番号と、2050 年以降の有効期限で生成する
    const cert = new X509Certificate(
      createSelfSignedCertificatePem({
        publicKey,
        privateKey,
        signatureAlgorithm: "ecdsa-sha256",
        name: [["CN", "werift"]],
        notBefore: new Date("2049-12-31T23:59:59Z"),
        notAfter: new Date("2050-01-01T00:00:00Z"),
        serialNumber: Buffer.from("ff00000000000001", "hex"),
      }),
    );

    // Assert: シリアル番号は正の整数として読める（先頭に 0x00 が補われる）
    expect(cert.serialNumber.replace(/^00/, "")).toBe("FF00000000000001");
    // Assert: UTCTime / GeneralizedTime の両方の時刻が正しく読める
    expect(new Date(cert.validFrom).toISOString()).toBe(
      "2049-12-31T23:59:59.000Z",
    );
    expect(new Date(cert.validTo).toISOString()).toBe(
      "2050-01-01T00:00:00.000Z",
    );
    expect(cert.subject).toBe("CN=werift");
    expect(cert.verify(publicKey)).toBe(true);
  });
});
