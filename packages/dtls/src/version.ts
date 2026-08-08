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

export function dtlsVersionToWire(v: DtlsVersion): number {
  return v === DtlsVersion.V1_3 ? DTLS_1_3_VERSION : DTLS_1_2_VERSION;
}

export function wireToDtlsVersion(n: number): DtlsVersion | undefined {
  if (n === DTLS_1_3_VERSION) return DtlsVersion.V1_3;
  if (n === DTLS_1_2_VERSION) return DtlsVersion.V1_2;
  return undefined;
}

/**
 * Association-layer version selection (both roles).
 * Walks `localPreference` in order and returns the first version also in
 * `peerSupported`. Empty intersection → ProtocolVersionError.
 */
export function selectVersion(
  localPreference: readonly DtlsVersion[],
  peerSupported: readonly DtlsVersion[],
): DtlsVersion {
  const peer = new Set(peerSupported);
  for (const v of localPreference) {
    if (peer.has(v)) return v;
  }
  throw new ProtocolVersionError(
    `no overlapping DTLS protocol version (local=[${localPreference.join(",")}] peer=[${peerSupported.join(",")}])`,
  );
}

/**
 * Map ClientHello supported_versions wire list → DtlsVersion[].
 * Unknown codepoints are ignored. Empty / missing → treat as DTLS 1.2 only
 * (legacy peers without the extension).
 */
export function peerVersionsFromSupportedVersionsWire(
  wireVersions: readonly number[] | undefined,
): DtlsVersion[] {
  if (!wireVersions || wireVersions.length === 0) {
    return [DtlsVersion.V1_2];
  }
  const out: DtlsVersion[] = [];
  const seen = new Set<DtlsVersion>();
  for (const w of wireVersions) {
    const v = wireToDtlsVersion(w);
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.length > 0 ? out : [DtlsVersion.V1_2];
}

export function protocolVersionsToWire(
  versions: readonly DtlsVersion[],
): number[] {
  return versions.map(dtlsVersionToWire);
}

export class ProtocolVersionError extends Error {
  readonly code = "protocol_version";
  constructor(message: string) {
    super(message);
    this.name = "ProtocolVersionError";
  }
}

/**
 * Intentional dual-stack version selection result (not a handshake failure).
 * Association layer switches engines; must not be treated as public onError.
 */
export class DtlsVersionSelected extends Error {
  readonly code = "version_selected";
  constructor(
    public readonly version: DtlsVersion,
    message?: string,
  ) {
    super(message ?? `selected DTLS ${version}`);
    this.name = "DtlsVersionSelected";
  }
}
