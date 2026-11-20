/**
 * Version-neutral association peer identity and address helpers.
 * Shared by DTLS 1.2 ({@link DtlsSocket}) and DTLS 1.3 engine.
 */

export type AddressValidationMode =
  | "dtls-cookie"
  | "ice-authenticated"
  | "none";

/**
 * How the association identifies the remote peer for TX/RX lifecycle.
 *
 * - `"datagram-address"` — UDP 5-tuple pin after cookie/connect: datagrams
 *   from another source are dropped and TX goes to the pinned peer
 * - `"authenticated-single-peer"` — transport path is the identity (ICE);
 *   addressless and non-matching 5-tuples do not drop authenticated RX
 * - `"unpinned"` — DTLS 1.2 only: no pin. Every source is processed and TX
 *   follows the transport's last remote address (the behavior before the
 *   association pin). A DTLS 1.3 engine always uses `"datagram-address"`
 *   instead.
 */
export type PeerIdentityMode =
  | "datagram-address"
  | "authenticated-single-peer"
  | "unpinned";

/**
 * Resolve peer-identity policy (1.2 association + 1.3 engine).
 *
 * Unless set explicitly, an ICE-style transport is `"authenticated-single-peer"`;
 * otherwise the address pin is opt-in through DTLS 1.3: offering DTLS 1.3
 * (`protocolVersions` including "1.3") pins (`"datagram-address"`), and a DTLS
 * 1.2-only association stays `"unpinned"`.
 */
export function resolvePeerIdentityMode(opts: {
  peerIdentityMode?: PeerIdentityMode;
  addressValidation?: AddressValidationMode;
  transport?: { peerAuthenticated?: boolean };
  /** Offered versions; omitted means a DTLS 1.3 engine. */
  offersDtls13?: boolean;
}): PeerIdentityMode {
  if (opts.peerIdentityMode) return opts.peerIdentityMode;
  if (opts.transport?.peerAuthenticated === true) {
    return "authenticated-single-peer";
  }
  if (opts.addressValidation === "ice-authenticated") {
    return "authenticated-single-peer";
  }
  return opts.offersDtls13 === false ? "unpinned" : "datagram-address";
}

/**
 * Lifecycle peer-auth (alerts / version errors), distinct from TX pin routing.
 * Either a return-routability pin or ICE-style transport identity is enough.
 */
export function associationHasPeerAuth(opts: {
  hasPinnedPeer: boolean;
  identityMode: PeerIdentityMode;
}): boolean {
  return (
    opts.hasPinnedPeer ||
    opts.identityMode === "authenticated-single-peer" ||
    // No pin to wait for: every source drives the lifecycle.
    opts.identityMode === "unpinned"
  );
}

/**
 * Map unspecified bind addresses to loopback so pin keys match local UDP
 * sources (tests often report 0.0.0.0 / :: from `UdpTransport.address`).
 */
export function normalizeLoopbackHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "::1";
  return host;
}

export function normalizePeerTuple(addr: [string, number]): [string, number] {
  return [normalizeLoopbackHost(addr[0]), addr[1]];
}
