import { RTCPeerConnection } from "../../../packages/webrtc/src";
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

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", async (data: any) => {
    const sdp = JSON.parse(data);
    console.log("signaling", sdp.type);
    await pc.setRemoteDescription(sdp);

    if (sdp.type === "offer") {
      await pc.setLocalDescription(await pc.createAnswer());
      socket.send(JSON.stringify(pc.localDescription));
    }
  });
});
