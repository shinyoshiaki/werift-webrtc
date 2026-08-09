import { Certificate as FidmCertificate } from "@fidm/x509";
import { createPrivateKey, createSign, X509Certificate } from "crypto";
import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { SignatureScheme } from "../../src/cipher/const";
import { hashSha256 } from "../../src/cipher/tls13/hkdf";
import {
  isSecp256r1Curve,
  schemesForKey,
  signCertificateVerify,
  verifyCertificateVerify,
} from "../../src/cipher/tls13/signature";
import { buildCertificateVerifyContent } from "../../src/handshake/message/tls13/certificateVerify";
import {
  certPem,
  ecdsaP256CertPem,
  ecdsaP256KeyPem,
  ecdsaP384CertPem,
  ecdsaP384KeyPem,
  keyPem,
} from "../fixture";

describe("e2e/self13 ECDSA P-256 CertificateVerify", () => {
  test("full handshake with P-256 ECDSA certificate (positive)", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const opts = {
      cert: ecdsaP256CertPem,
      key: ecdsaP256KeyPem,
      protocolVersions: [DtlsVersion.V1_3] as const,
      addressValidation: "none" as const,
    };
    const server = new DtlsServer({ transport: serverTransport, ...opts });
    const client = new DtlsClient({
      transport: clientTransport,
      // client may be cert-less for server-auth-only
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });

    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("ecdsa p256 handshake timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onData.subscribe((data) => {
        expect(data.toString()).toBe("ecdsa-p256");
        void server.send(Buffer.from("ecdsa-ok"));
      });
      client.onData.subscribe((data) => {
        expect(data.toString()).toBe("ecdsa-ok");
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });
      client.onConnect.subscribe(() => {
        void client.send(Buffer.from("ecdsa-p256"));
      });
      // Act
      await client.connect();
    });
  }, 20_000);

  test("P-384 server certificate fails scheme negotiation (negative)", async () => {
    // Arrange: server only has P-384 EC key → no ecdsa_secp256r1_sha256
    expect(schemesForKey(ecdsaP384KeyPem)).toEqual([]);
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const server = new DtlsServer({
      transport: serverTransport,
      cert: ecdsaP384CertPem,
      key: ecdsaP384KeyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    const client = new DtlsClient({
      transport: clientTransport,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });

    // Act / Assert: handshake must fail (no overlapping CV scheme)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("p384 should fail promptly")),
        8_000,
      );
      const onFail = (e: Error) => {
        clearTimeout(timer);
        expect(e.message).toMatch(
          /signature scheme|overlapping|CertificateVerify|handshake/i,
        );
        try {
          client.close();
        } catch {
          /* */
        }
        try {
          server.close();
        } catch {
          /* */
        }
        resolve();
      };
      client.onError.subscribe(onFail);
      server.onError.subscribe(onFail);
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        reject(new Error("must not connect with P-384-only server cert"));
      });
      void client.connect();
    });
  }, 15_000);
});

describe("CertificateVerify curve / key type binding", () => {
  test("schemesForKey: P-256 offers ecdsa; P-384 offers none; RSA offers PSS", () => {
    // Arrange / Act / Assert
    expect(schemesForKey(ecdsaP256KeyPem)).toEqual([
      SignatureScheme.ecdsa_secp256r1_sha256,
    ]);
    expect(schemesForKey(ecdsaP384KeyPem)).toEqual([]);
    expect(schemesForKey(keyPem)).toEqual([
      SignatureScheme.rsa_pss_rsae_sha256,
    ]);
    expect(isSecp256r1Curve("prime256v1")).toBe(true);
    expect(isSecp256r1Curve("secp384r1")).toBe(false);
  });

  test("verifyCertificateVerify rejects ecdsa_secp256r1_sha256 on P-384 cert", () => {
    // Arrange: craft a signature with P-384 key claiming P-256 scheme
    const transcript = Buffer.alloc(32, 7);
    const content = buildCertificateVerifyContent(
      true,
      hashSha256(transcript),
    );
    const signer = createSign("sha256");
    signer.update(content);
    const sig = signer.sign(createPrivateKey(ecdsaP384KeyPem));
    // Act / Assert
    expect(() =>
      verifyCertificateVerify(
        new X509Certificate(ecdsaP384CertPem).raw,
        SignatureScheme.ecdsa_secp256r1_sha256,
        sig,
        true,
        transcript,
      ),
    ).toThrow(/P-256|namedCurve|secp384|illegal_parameter/i);
  });

  test("verifyCertificateVerify rejects ecdsa scheme on RSA cert", () => {
    // Arrange: RSA signature bytes used with wrong algorithm label
    const transcript = Buffer.alloc(16, 1);
    const { signature } = signCertificateVerify(keyPem, true, transcript);
    const der = FidmCertificate.fromPEM(Buffer.from(certPem)).raw;
    // Act / Assert
    expect(() =>
      verifyCertificateVerify(
        der,
        SignatureScheme.ecdsa_secp256r1_sha256,
        signature,
        true,
        transcript,
      ),
    ).toThrow(/not EC|illegal_parameter/i);
  });

  test("signCertificateVerify rejects P-384 private key", () => {
    // Arrange / Act / Assert
    expect(() =>
      signCertificateVerify(ecdsaP384KeyPem, true, Buffer.alloc(8)),
    ).toThrow(/P-256|namedCurve|secp384/i);
  });

  test("P-256 CertificateVerify roundtrip verifies", () => {
    // Arrange
    const transcript = Buffer.from("p256-cv-transcript");
    const { algorithm, signature } = signCertificateVerify(
      ecdsaP256KeyPem,
      true,
      transcript,
    );
    const der = FidmCertificate.fromPEM(Buffer.from(ecdsaP256CertPem)).raw;
    // Act
    const ok = verifyCertificateVerify(
      der,
      algorithm,
      signature,
      true,
      transcript,
    );
    // Assert
    expect(algorithm).toBe(SignatureScheme.ecdsa_secp256r1_sha256);
    expect(ok).toBe(true);
  });
});
