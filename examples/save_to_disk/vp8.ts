import { MediaRecorder, RTCPeerConnection } from "../../packages/webrtc/src";
import { Server } from "ws";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const recorder = new MediaRecorder(`./vp8-${Date.now()}.webm`, 2, {
    width: 640,
    height: 360,
  });

  const pc = new RTCPeerConnection();

  pc.addTransceiver("video").onTrack.subscribe(async (track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 3_000);
    await recorder.addTrack(track);
  });

  pc.addTransceiver("audio").onTrack.subscribe(async (track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    await recorder.addTrack(track);
  });

  setTimeout(async () => {
    await recorder.stop();
    console.log("stop");
  }, 15_000);

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
