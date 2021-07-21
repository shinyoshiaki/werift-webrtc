import { RTCPeerConnection } from "../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});

  pc.addTransceiver("video", { direction: "recvonly" });

  await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify(pc.localDescription));

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
