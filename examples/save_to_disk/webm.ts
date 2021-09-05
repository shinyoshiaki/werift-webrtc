import { MediaRecorder, RTCPeerConnection } from "../../packages/webrtc/src";
import { Server } from "ws";

// open ./answer.html

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const recorder = new MediaRecorder([], "./test.webm", {
    width: 640,
    height: 360,
  });

  const pc = new RTCPeerConnection();

  {
    const transceiver = pc.addTransceiver("video");

    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);

      recorder.addTrack(track);
      if (recorder.tracks.length === 2) {
        recorder.start();
      }

      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 10_000);
    });
  }
  {
    const transceiver = pc.addTransceiver("audio");
    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);

      recorder.addTrack(track);
      if (recorder.tracks.length === 2) {
        recorder.start();
      }
    });
  }

  setTimeout(() => {
    recorder.stop();
    console.log("stop");
  }, 60_000 * 60 * 3);

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
