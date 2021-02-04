import { RTCPeerConnection } from "../../../packages/webrtc/src";
import io from "socket.io-client";

const socket = io("https://serene-anchorage-28732.herokuapp.com/");

console.log("start browser first");

(async () => {
  const pc = new RTCPeerConnection({});
  pc.onIceCandidate.subscribe((candidate) => {
    socket.emit("sdp", {
      candidate: JSON.stringify(candidate.toJSON()),
      roomId: "test",
    });
  });
  const transceiver = pc.addTransceiver("video", "sendrecv");
  transceiver.onTrack.subscribe((track) =>
    track.onRtp.subscribe(transceiver.sendRtp)
  );

  const offer = pc.createOffer();
  pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);

  socket.emit("join", { roomId: "test" });
  socket.on("join", () => {
    console.log("join");
    socket.emit("sdp", { sdp, roomId: "test" });
  });
  socket.on("sdp", (data: any) => {
    console.log(data);
    const msg = JSON.parse(data.sdp);
    if (msg.sdp) {
      pc.setRemoteDescription(msg);
    } else if (msg.candidate) {
      console.log(data.candidate);
      pc.addIceCandidate(msg);
    }
  });
})();
