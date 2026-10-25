import { type KeyObject, randomBytes, sign } from "node:crypto";

import {
  encodeDerBitString,
  encodeDerExplicit,
  encodeDerInteger,
  encodeDerNull,
  encodeDerOid,
  encodeDerPrintableString,
  encodeDerSequence,
  encodeDerSet,
  encodeDerTime,
  encodeDerUtf8String,
  encodePem,
} from "../imports/common";

/** Signature algorithms supported by {@link createSelfSignedCertificatePem}. */
export type CertificateSignatureAlgorithm = "ecdsa-sha256" | "rsa-sha256";

const signatureAlgorithms: Record<
  CertificateSignatureAlgorithm,
  { identifier: Buffer; hash: string }
> = {
  // ecdsa-with-SHA256 (RFC 5758): parameters MUST be absent
  "ecdsa-sha256": {
    identifier: encodeDerSequence(encodeDerOid("1.2.840.10045.4.3.2")),
    hash: "sha256",
  },
  // sha256WithRSAEncryption (RFC 4055): parameters MUST be NULL
  "rsa-sha256": {
    identifier: encodeDerSequence(
      encodeDerOid("1.2.840.113549.1.1.11"),
      encodeDerNull(),
    ),
    hash: "sha256",
  },
};

const attributeTypes = {
  C: "2.5.4.6",
  ST: "2.5.4.8",
  L: "2.5.4.7",
  O: "2.5.4.10",
  OU: "2.5.4.11",
  CN: "2.5.4.3",
} as const;

export type CertificateNameAttribute = keyof typeof attributeTypes;

/**
 * Encodes an X.501 Name with one attribute per RDN, in the given order.
 * `C` uses PrintableString (RFC 5280 Appendix A); the others use UTF8String.
 */
export function encodeCertificateName(
  attributes: [CertificateNameAttribute, string][],
) {
  return encodeDerSequence(
    ...attributes.map(([type, value]) =>
      encodeDerSet(
        encodeDerSequence(
          encodeDerOid(attributeTypes[type]),
          type === "C"
            ? encodeDerPrintableString(value)
            : encodeDerUtf8String(value),
        ),
      ),
    ),
  );
}

/**
 * Creates a self-signed X.509 v3 certificate (RFC 5280) without extensions,
 * signed by `privateKey`.
 * @returns certificate in PEM
 */
export function createSelfSignedCertificatePem({
  publicKey,
  privateKey,
  signatureAlgorithm,
  name,
  notBefore,
  notAfter,
  serialNumber = randomBytes(8),
}: {
  publicKey: KeyObject;
  privateKey: KeyObject;
  signatureAlgorithm: CertificateSignatureAlgorithm;
  name: [CertificateNameAttribute, string][];
  notBefore: Date;
  notAfter: Date;
  serialNumber?: Buffer;
}) {
  const { identifier, hash } = signatureAlgorithms[signatureAlgorithm];
  const encodedName = encodeCertificateName(name);

  const tbsCertificate = encodeDerSequence(
    // version: v3
    encodeDerExplicit(0, encodeDerInteger(2)),
    encodeDerInteger(serialNumber),
    identifier,
    // issuer = subject for a self-signed certificate
    encodedName,
    encodeDerSequence(encodeDerTime(notBefore), encodeDerTime(notAfter)),
    encodedName,
    publicKey.export({ type: "spki", format: "der" }),
  );

  // node:crypto emits DER-encoded ECDSA signatures by default, as X.509 requires
  const signature = sign(hash, tbsCertificate, privateKey);

  const certificate = encodeDerSequence(
    tbsCertificate,
    identifier,
    encodeDerBitString(signature),
  );
  return encodePem("CERTIFICATE", certificate);
}
