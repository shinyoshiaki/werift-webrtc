import { RTCPeerConnection } from "../../../packages/webrtc/src";
import { Server } from "ws";
import { createSocket } from "dgram";

const server = new Server({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
  transceiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((packet) => {
      udp.send(packet.serialize(), 1234, "127.0.0.1");
    });

    setInterval(() => {
      if (track.ssrc) {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }
    }, 1000);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
