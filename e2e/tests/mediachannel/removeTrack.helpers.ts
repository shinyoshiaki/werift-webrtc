import { peer } from "../fixture";

const method = "mediachannel_offer_replace_second";

export function mediaSections(sdp: string) {
  return sdp
    .split(/(?=^m=)/m)
    .slice(1)
    .map((section) => ({
      port: Number(section.split(" ")[1]),
      mid: section.match(/^a=mid:(.+)$/m)?.[1].trim(),
    }));
}

export async function createReuseBrowserPair(
  mLineReuse: "compatible" | "aggressive",
) {
  if (!peer.connected)
    await new Promise<void>((resolve) => peer.on("open", resolve));
  await peer.request(method, { type: "init", payload: { mLineReuse } });
  const pc = new RTCPeerConnection({ iceServers: [] });
  let track: MediaStreamTrack | undefined;
  const request = (type: string, payload?: unknown) =>
    peer.request(method, { type, payload });
  const negotiate = async () => {
    await pc.setLocalDescription(await pc.createOffer());
    const answer = await request("offer", pc.localDescription);
    await pc.setRemoteDescription(answer);
  };
  const close = async () => {
    pc.close();
    track?.stop();
    await request("done");
  };
  try {
    track = (
      await navigator.mediaDevices.getUserMedia({ video: true })
    ).getVideoTracks()[0];
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) void request("candidate", candidate);
    };
    pc.addTransceiver(track, { direction: "sendonly" });
    const second = pc.addTransceiver(track, { direction: "sendonly" });
    await negotiate();
    await request("check", { index: 1 });
    return { pc, track, second, negotiate, request, close };
  } catch (error) {
    await close();
    throw error;
  }
}
