import { RTCPeerConnection } from "../../../packages/webrtc/src";
import io from "socket.io-client";

const socket = io("https://serene-anchorage-28732.herokuapp.com/");

(async () => {
  const pc = new RTCPeerConnection({});
  const transceiver = pc.addTransceiver("video");
  transceiver.onTrack.subscribe((track) => {
    transceiver.sender.replaceTrack(track);
  });

  await pc.setLocalDescription(await pc.createOffer());

  socket.emit("join", { roomId: "test" });
  socket.on("join", () => {
    console.log("start browser first");
    socket.emit("sdp", {
      sdp: JSON.stringify(pc.localDescription),
      roomId: "test",
    });
  });
  socket.on("sdp", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data.sdp));
  });
})();
