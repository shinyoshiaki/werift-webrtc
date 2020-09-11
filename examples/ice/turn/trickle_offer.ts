import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    turnServer: ["relay.backups.cz", 3478],
    turnUsername: "webrtc",
    turnPassword: "webrtc",
    forceTurn: true,
  });
  pc.onIceCandidate.subscribe((candidate) => {
    socket.send(JSON.stringify(candidate.toJSON()));
  });

  const transceiver = pc.addTransceiver("video", "sendrecv");
  transceiver.onTrack.subscribe((track) =>
    track.onRtp.subscribe(transceiver.sendRtp)
  );

  const offer = pc.createOffer();
  pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  console.log(sdp);
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
