/**
 * Trickle queue for candidates werift sends to the browser. A candidate is
 * added once the remote description it belongs to is applied: before any
 * remote description, and, after an ICE restart, until the description with
 * the candidate's `usernameFragment` is applied. werift trickles the new
 * generation's candidates while that description is still on its way, and
 * Firefox rejects them with "OperationError: Unknown ufrag" as the spec says.
 * Candidates that never match (a superseded generation) are left out.
 */
export function createNativeCandidateQueue(pc: RTCPeerConnection) {
  const pending: Array<RTCIceCandidateInit | null> = [];

  const belongsToRemoteDescription = (
    candidate: RTCIceCandidateInit | null,
  ) => {
    const sdp = pc.remoteDescription?.sdp;
    if (sdp === undefined) return false;
    const ufrag = candidate?.usernameFragment;
    if (!ufrag) return true;
    return sdp.split(/\r?\n/).includes(`a=ice-ufrag:${ufrag}`);
  };

  return {
    async add(candidate: RTCIceCandidateInit | null) {
      if (!belongsToRemoteDescription(candidate)) {
        pending.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    },
    /** Add the queued candidates the current remote description accepts. */
    async flush() {
      const queued = pending.splice(0);
      for (const candidate of queued) {
        if (belongsToRemoteDescription(candidate)) {
          await pc.addIceCandidate(candidate ?? null);
        } else {
          pending.push(candidate);
        }
      }
    },
  };
}
