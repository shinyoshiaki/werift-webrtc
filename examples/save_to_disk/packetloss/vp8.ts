import {
  MediaRecorder,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useNACK,
  usePLI,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

// open ./answer.html

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const recorder = new MediaRecorder([], "./test.webm", {
    width: 640,
    height: 360,
  });

  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [useNACK(), usePLI()],
        }),
      ],
    },
  });

  pc.addTransceiver("video").onTrack.subscribe((track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    recorder.addTrack(track);
    recorder.start();

    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 5000);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  setTimeout(() => {
    recorder.stop();
    console.log("stop");
  }, 15_000);
});
