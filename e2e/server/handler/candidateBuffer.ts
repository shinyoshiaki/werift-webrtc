import type { RTCPeerConnection } from "..";

type PendingCandidate = Parameters<RTCPeerConnection["addIceCandidate"]>[0];

export function createCandidateBuffer(pc: RTCPeerConnection) {
  const pending: PendingCandidate[] = [];

  return {
    async add(candidate: PendingCandidate) {
      // addIceCandidate() は remoteDescription 未設定時に reject されるため、
      // signaling 経路で候補が先行到着したぶんだけ一時保留する。
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
        await pc.addIceCandidate(candidate);
      }
    },
  };
}
