export function createCandidateBuffer(pc: RTCPeerConnection) {
  const pending: Array<RTCIceCandidateInit | null> = [];

  return {
    async add(candidate: RTCIceCandidateInit | null) {
      // addIceCandidate() は remoteDescription 未設定の間は reject されるため、
      // trickle で先行到着した候補をブラウザ側でも一時保留する。
      if (!pc.remoteDescription) {
        pending.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    },
    async flush() {
      if (!pc.remoteDescription) {
        return;
      }
      while (pending.length > 0) {
        const candidate = pending.shift();
        await pc.addIceCandidate(candidate ?? null);
      }
    },
  };
}
