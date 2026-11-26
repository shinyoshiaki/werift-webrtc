import type { Peer } from "protoo-server";

/** ICE gathering can finish after the signaling peer disconnects. */
export async function notifyIceCandidate(peer: Peer, candidate: unknown) {
  if (peer.closed) return;

  try {
    await peer.notify("candidate", { candidate });
  } catch (error) {
    if (
      peer.closed ||
      (error instanceof Error && error.message === "transport closed")
    ) {
      return;
    }
    throw error;
  }
}
