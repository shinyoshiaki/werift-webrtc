import type { Peer } from "protoo-server";
import type { RTCIceCandidate } from "..";

export function notifyCandidate(peer: Peer, candidate: RTCIceCandidate | null) {
  if (peer.closed) return;

  // ブラウザーの切断後に届く candidate は不要なので、通知失敗を無視する。
  void peer.notify("candidate", { candidate }).catch(() => {});
}
