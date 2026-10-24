import type { SessionDescription } from "../sdp";

/** Local ICE ufrags of the accepted m-lines of `description`. */
export function localIceUfrags(description?: SessionDescription) {
  return (description?.media ?? [])
    .filter((media) => media.port !== 0)
    .map((media) => media.iceParams?.usernameFragment)
    .filter((ufrag): ufrag is string => !!ufrag);
}

/**
 * A `restartIce()` request (W3C). It records the local ufrags of the current
 * and the pending local description to replace
 * ([[LocalIceCredentialsToReplace]]). Every offer restarts ICE while the
 * request stands; a rollback or glare keeps it, and it clears only when an
 * answer commits local credentials outside that set.
 */
export class IceRestartRequest {
  requested = false;
  private toReplace = new Set<string>();

  request(current?: SessionDescription, pending?: SessionDescription) {
    this.requested = true;
    this.toReplace = new Set([
      ...localIceUfrags(current),
      ...localIceUfrags(pending),
    ]);
  }

  /** The local ufrags the next offer must not carry again. */
  get replacing(): ReadonlySet<string> {
    return this.toReplace;
  }

  /** Nothing current to replace: fresh credentials satisfy the request. */
  clear() {
    this.requested = false;
    this.toReplace.clear();
  }

  /** An answer committed `current`: settle the request if it replaced them all. */
  settle(current?: SessionDescription) {
    if (!this.requested) return;
    if (localIceUfrags(current).some((ufrag) => this.toReplace.has(ufrag))) {
      return;
    }
    this.clear();
  }
}
