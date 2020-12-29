import { RTCPeerConnection } from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    turnServer: ["35.200.71.35", 3478],
    turnUsername: "webrtc",
    turnPassword: "webrtc",
    forceTurn: true,
  });

  const transceiver = pc.addTransceiver("video", "sendrecv");
  transceiver.onTrack.subscribe(async (track) => {
    track.onRtp.subscribe(transceiver.sendRtp);
    await track.onRtp.asPromise();
    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 1000);
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    const msg = JSON.parse(data);
    if (msg.candidate) {
      console.log("on candidate");
      pc.addIceCandidate(msg);
    } else {
      pc.setRemoteDescription(msg);
    }
  });
});
