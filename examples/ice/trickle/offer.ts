import { RTCPeerConnection } from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.onIceCandidate.subscribe((candidate) => {
    socket.send(JSON.stringify(candidate));
  });

  const transceiver = pc.addTransceiver("video");
  transceiver.onTrack.subscribe((track) =>
    transceiver.sender.replaceTrack(track)
  );

  pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    const msg = JSON.parse(data);
    if (msg.candidate) {
      pc.addIceCandidate(msg);
    } else {
      pc.setRemoteDescription(msg);
    }
  });
});
