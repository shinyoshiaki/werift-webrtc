import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { createSocket } from "dgram";

const server = new Server({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  pc.addTransceiver("video", "recvonly").receiver.onRtp.subscribe((packet) => {
    udp.send(packet.serialize(), 4002, "127.0.0.1");
  });
  pc.addTransceiver("audio", "recvonly").receiver.onRtp.subscribe((packet) => {
    udp.send(packet.serialize(), 4003, "127.0.0.1");
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
