import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../packages/webrtc/src";
import { MediaRecorder } from "../../packages/webrtc/src/nonstandard";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const recorder = new MediaRecorder({
    path: "./test.webm",
    numOfTracks: 2,
    width: 640,
    height: 360,
  });

  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP9",
          clockRate: 90000,
          rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "goog-remb" },
          ],
        }),
      ],
    },
  });

  {
    const transceiver = pc.addTransceiver("video");

    transceiver.onTrack.subscribe(async (track) => {
      transceiver.sender.replaceTrack(track);

      await recorder.addTrack(track);

      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 2_000);
    });
  }
  {
    const transceiver = pc.addTransceiver("audio");
    transceiver.onTrack.subscribe(async (track) => {
      transceiver.sender.replaceTrack(track);

      await recorder.addTrack(track);
    });
  }

  setTimeout(() => {
    recorder.stop();
    console.log("stop");
  }, 10_000);

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
