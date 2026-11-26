import {
  fingerprint,
  normalizeFingerprintAlgorithm,
  normalizeFingerprintValue,
} from "../utils";
import type { RTCDtlsFingerprint } from "./dtls-certificate";

export const deduplicateFingerprints = (fingerprints: RTCDtlsFingerprint[]) => {
  const seen = new Set<string>();
  return fingerprints.filter(({ algorithm, value }) => {
    const key = `${
      normalizeFingerprintAlgorithm(algorithm) ?? algorithm.trim().toLowerCase()
    }:${normalizeFingerprintValue(value)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const preferredFingerprintAlgorithms = [
  "sha512",
  "sha384",
  "sha256",
  "sha224",
  "sha1",
] as const;

const selectPreferredFingerprintAlgorithm = (
  fingerprints: { normalizedAlgorithm: string }[],
) => {
  return (
    preferredFingerprintAlgorithms.find((algorithm) =>
      fingerprints.some(
        ({ normalizedAlgorithm }) => normalizedAlgorithm === algorithm,
      ),
    ) ?? fingerprints[0].normalizedAlgorithm
  );
};

/**
 * Throws unless `remoteCertificate` matches one of the SDP fingerprints of
 * the strongest supported algorithm the remote advertised.
 */
export function verifyRemoteCertificateFingerprint(
  fingerprints: readonly RTCDtlsFingerprint[] | undefined,
  remoteCertificate: Buffer | undefined,
) {
  if (!fingerprints || fingerprints.length === 0) {
    throw new Error("remote fingerprint not exist");
  }

  if (!remoteCertificate) {
    throw new Error("remote certificate not available");
  }

  const supportedFingerprints = fingerprints.flatMap(({ algorithm, value }) => {
    const normalizedAlgorithm = normalizeFingerprintAlgorithm(algorithm);
    if (!normalizedAlgorithm) {
      return [];
    }

    const normalizedValue = normalizeFingerprintValue(value);
    if (!normalizedValue) {
      throw new Error("remote fingerprint value is empty");
    }

    return [{ normalizedAlgorithm, normalizedValue }];
  });
  if (supportedFingerprints.length === 0) {
    throw new Error("no supported remote fingerprint algorithms");
  }

  const preferredAlgorithm = selectPreferredFingerprintAlgorithm(
    supportedFingerprints,
  );
  const expectedFingerprints = supportedFingerprints.filter(
    ({ normalizedAlgorithm }) => normalizedAlgorithm === preferredAlgorithm,
  );

  const actualFingerprints = expectedFingerprints.reduce(
    (acc, { normalizedAlgorithm }) => {
      if (!acc.has(normalizedAlgorithm)) {
        acc.set(
          normalizedAlgorithm,
          normalizeFingerprintValue(
            fingerprint(remoteCertificate, normalizedAlgorithm),
          ),
        );
      }
      return acc;
    },
    new Map<string, string>(),
  );

  const matched = expectedFingerprints.some(
    ({ normalizedAlgorithm, normalizedValue }) =>
      actualFingerprints.get(normalizedAlgorithm) === normalizedValue,
  );

  if (!matched) {
    throw new Error("remote certificate fingerprint mismatch");
  }
}
