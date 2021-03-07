import { RTCPeerConnection } from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );

  const transceiver1 = pc.addTransceiver("video", "sendrecv");
  const transceiver2 = pc.addTransceiver("video", "sendrecv");

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  await transceiver1.sender.onReady.asPromise();
  transceiver1.receiver.tracks[0].onRtp.subscribe((rtp) => {
    transceiver1.sendRtp(rtp.serialize());
  });
  transceiver2.receiver.tracks[0].onRtp.subscribe((rtp) => {
    transceiver2.sendRtp(rtp.serialize());
  });
});
