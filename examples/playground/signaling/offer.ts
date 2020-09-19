import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );

  pc.addTransceiver("video", "sendonly"); // dummy

  pc.createDataChannel("test");

  pc.onTransceiver.subscribe((transceiver) => {
    transceiver.onTrack.subscribe((track) => {
      track.onRtp.subscribe(transceiver.sendRtp);
    });
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", async (data: any) => {
    const sdp = JSON.parse(data);
    console.log("signaling", sdp.type);
    await pc.setRemoteDescription(sdp);

    if (sdp.type === "offer") {
      const answer = pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.send(JSON.stringify(answer));
    }
  });
});
