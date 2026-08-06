/**
 * DTLS protocol version selection for public Options.
 * Default when omitted is DTLS 1.2 only for backward compatibility.
 */
export enum DtlsVersion {
  V1_2 = "1.2",
  V1_3 = "1.3",
}

/** Wire version constants (RFC 6347 / RFC 9147). */
export const WireVersion = {
  /** DTLS 1.2 wire version 0xfefd */
  DTLS_1_2: { major: 254, minor: 253 },
  /** DTLS 1.3 wire version 0xfefc */
  DTLS_1_3: { major: 254, minor: 252 },
} as const;

export const DTLS_1_2_VERSION = 0xfefd;
export const DTLS_1_3_VERSION = 0xfefc;

export function wireVersionToNumber(v: {
  major: number;
  minor: number;
}): number {
  return (v.major << 8) | v.minor;
}

export function numberToWireVersion(n: number): {
  major: number;
  minor: number;
} {
  return { major: (n >> 8) & 0xff, minor: n & 0xff };
}

export function normalizeProtocolVersions(
  versions?: readonly DtlsVersion[],
): DtlsVersion[] {
  if (!versions || versions.length === 0) {
    return [DtlsVersion.V1_2];
  }
  // Preserve order (priority) while de-duplicating
  const seen = new Set<DtlsVersion>();
  const out: DtlsVersion[] = [];
  for (const v of versions) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function supportsVersion(
  versions: readonly DtlsVersion[],
  target: DtlsVersion,
): boolean {
  return versions.includes(target);
}

export class ProtocolVersionError extends Error {
  readonly code = "protocol_version";
  constructor(message: string) {
    super(message);
    this.name = "ProtocolVersionError";
  }
}
