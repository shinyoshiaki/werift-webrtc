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
  // Epic 1 supported dual pattern is [V1_3, V1_2] only.
  // Preferring 1.2 while advertising 1.3 requires full downgrade-sentinel server
  // semantics — fail-fast rather than silently rewriting preference order.
  if (
    out.includes(DtlsVersion.V1_2) &&
    out.includes(DtlsVersion.V1_3) &&
    out[0] !== DtlsVersion.V1_3
  ) {
    throw new Error(
      "protocolVersions [V1_2, V1_3] is not supported; use [V1_3, V1_2]",
    );
  }
  return out;
}

/** TLS 1.3 / DTLS 1.3 ServerHello.random downgrade sentinels (RFC 8446 §4.1.3). */
export const DOWNGRADE_TLS12_SENTINEL = Buffer.from("444F574E47524401", "hex"); // DOWNGRD\x01
export const DOWNGRADE_TLS11_SENTINEL = Buffer.from("444F574E47524400", "hex"); // DOWNGRD\x00

/**
 * TLS 1.3 client check: if we offered 1.3 but ServerHello negotiated ≤1.2,
 * abort when Random ends with a downgrade sentinel (1.3-capable server selected
 * lower version — typically MITM stripped ClientHello versions).
 */
export function hasTlsDowngradeSentinel(serverRandom32: Buffer): boolean {
  if (serverRandom32.length < 8) return false;
  const tail = serverRandom32.subarray(serverRandom32.length - 8);
  return (
    tail.equals(DOWNGRADE_TLS12_SENTINEL) ||
    tail.equals(DOWNGRADE_TLS11_SENTINEL)
  );
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
 *
 * - `undefined` (extension absent): legacy peer → [V1_2] only.
 * - present but empty after filter, or only unknown codepoints: []
 *   (no common version → caller must fail with protocol_version).
 * Unknown codepoints are skipped; they do not imply DTLS 1.2.
 */
export function peerVersionsFromSupportedVersionsWire(
  wireVersions: readonly number[] | undefined,
): DtlsVersion[] {
  // Extension not present — only this path is legacy DTLS 1.2
  if (wireVersions === undefined) {
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
  // Empty or unknown-only: no negotiable version (not legacy 1.2)
  return out;
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
 * Locally determined handshake/protocol negotiation failure.
 * Unlike forged UDP noise, these should alert (best-effort) and fail()
 * rather than silent-drop into retransmission timeout.
 */
export class DtlsProtocolError extends Error {
  readonly code = "protocol_error";
  constructor(
    message: string,
    public readonly alertDescription?: number,
  ) {
    super(message);
    this.name = "DtlsProtocolError";
  }
}

/**
 * Dual-stack association signal: peer used DTLS 1.2 HelloVerifyRequest cookie path.
 * Not a final version selection — association continues dual negotiation on the
 * 1.2 cookie path while still advertising supported_versions including 1.3.
 * Must not be treated as public onError.
 */
export class DtlsVersionSelected extends Error {
  readonly code = "version_selected";
  constructor(
    public readonly version: DtlsVersion,
    message?: string,
    /** Cookie from HelloVerifyRequest to continue dual CH on 1.2 path. */
    public readonly helloVerifyCookie?: Buffer,
  ) {
    super(message ?? `selected DTLS ${version}`);
    this.name = "DtlsVersionSelected";
  }
}
