// Spawned by stunFixture.test.ts: gathers with the public STUN server the
// demos name (werift has no default STUN server) and prints the result as one
// JSON line.
import { RTCPeerConnection } from "../../../../../packages/webrtc/src";

const startedAt = Date.now();
const pc = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});
pc.createDataChannel("probe");
await pc.setLocalDescription(await pc.createOffer());
await new Promise<void>((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  pc.iceGatheringStateChange.subscribe((state) => {
    if (state === "complete") resolve();
  });
});
const candidates = (pc.localDescription?.sdp ?? "")
  .split("\r\n")
  .filter((line) => line.startsWith("a=candidate:"))
  .map((line) => {
    const fields = line.split(" ");
    return { type: fields[7], address: fields[4] };
  });
console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, candidates }));
await pc.close();
