import type { AcceptFn } from "protoo-server";
import type { RTCPeerConnection } from "..";

type LocalDescriptionInput = Parameters<
  RTCPeerConnection["setLocalDescription"]
>[0];

export async function acceptLocalDescription(
  pc: RTCPeerConnection,
  description: LocalDescriptionInput,
  accept: AcceptFn,
) {
  await pc.setLocalDescription(description);
  accept(pc.localDescription);
}
