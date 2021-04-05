import { RTCPeerConnection } from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );

  const transceiver1 = pc.addTransceiver("video");
  const transceiver2 = pc.addTransceiver("video");

  transceiver1.onTrack.subscribe((track) => {
    transceiver1.sender.replaceTrack(track);
  });
  transceiver2.onTrack.subscribe((track) => {
    transceiver2.sender.replaceTrack(track);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
