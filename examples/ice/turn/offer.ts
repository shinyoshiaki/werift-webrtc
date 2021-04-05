import { RTCPeerConnection } from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    iceConfig: {
      turnServer: ["relay.backups.cz", 3478],
      turnUsername: "webrtc",
      turnPassword: "webrtc",
      forceTurn: true,
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  const transceiver = pc.addTransceiver("video");
  transceiver.onTrack.subscribe(async (track) => {
    transceiver.sender.replaceTrack(track);

    await track.onReceiveRtp.asPromise();
    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 1000);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
