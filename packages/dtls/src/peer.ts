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
 * - `"datagram-address"` — UDP 5-tuple pin after cookie/connect
 * - `"authenticated-single-peer"` — transport path is the identity (ICE);
 *   addressless and non-matching 5-tuples do not drop authenticated RX
 */
export type PeerIdentityMode = "datagram-address" | "authenticated-single-peer";

/** Resolve peer-identity policy (1.2 association + 1.3 engine). */
export function resolvePeerIdentityMode(opts: {
  peerIdentityMode?: PeerIdentityMode;
  addressValidation?: AddressValidationMode;
  transport?: { peerAuthenticated?: boolean };
}): PeerIdentityMode {
  if (opts.peerIdentityMode) return opts.peerIdentityMode;
  if (opts.transport?.peerAuthenticated === true) {
    return "authenticated-single-peer";
  }
  if (opts.addressValidation === "ice-authenticated") {
    return "authenticated-single-peer";
  }
  return "datagram-address";
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
    opts.hasPinnedPeer || opts.identityMode === "authenticated-single-peer"
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
