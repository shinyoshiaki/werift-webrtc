import { waitVideoPlay } from "../../tests/fixture";
import { WebSocketTransport, Peer } from "protoo-client";

const transport = new WebSocketTransport("ws://localhost:8886");
const peer = new Peer(transport);

(async () => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.ontrack = ({ track }) => {
    waitVideoPlay(track);
  };

  const [track] = (
    await navigator.mediaDevices.getUserMedia({ video: true })
  ).getTracks();
  pc.addTrack(track);

  const offer = await peer.request("mediachannel_sendrecv_answer", {
    type: "init",
  });
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());

  pc.onicecandidate = ({ candidate }) => {
    peer.request("mediachannel_sendrecv_answer", {
      type: "candidate",
      payload: candidate,
    });
  };

  peer.request("mediachannel_sendrecv_answer", {
    type: "answer",
    payload: pc.localDescription,
  });
})();
