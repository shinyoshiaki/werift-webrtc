import { RTCPeerConnection } from "../../src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  pc.onIceCandidate.subscribe((candidate) => {
    socket.send(JSON.stringify(candidate.toJSON()));
  });

  pc.addTransceiver("video", "recvonly").onTrack.subscribe((track) =>
    track.onRtp.subscribe((rtp) => {
      console.log(rtp);
      dc.send(rtp.payload);
    })
  );
  const dc = pc.createDataChannel("dc");

  const offer = pc.createOffer();
  pc.setLocalDescription(offer);
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
