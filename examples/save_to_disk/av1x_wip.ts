import {
  MediaRecorder,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "werift/src";
import { Server } from "ws";

// not working for now
// open ./answer.html

const server = new Server({ port: 8878 });
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
          mimeType: "video/AV1X",
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

    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);

      recorder.addTrack(track);
      if (recorder.tracks.length === 2) {
        recorder.start();
      }

      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 2_000);
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
  }, 60_000 * 60);

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
