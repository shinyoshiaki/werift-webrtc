import { Server } from "ws";
import { RTCPeerConnection } from "../../packages/webrtc/src";
import { MediaRecorder } from "../../packages/webrtc/src/nonstandard";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const recorder = new MediaRecorder({
    path: `./opus-${Date.now()}.webm`,
    numOfTracks: 1,
  });

  const pc = new RTCPeerConnection();

  pc.addTransceiver("video").onTrack.subscribe(async (track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 3_000);
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
