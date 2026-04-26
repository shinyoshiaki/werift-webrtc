import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RTP_EXTENSION_URI,
  useNACK,
  usePLI,
  useREMB,
  useVideoOrientation,
  type videoOrientationPayload,
} from "../../packages/webrtc/src";
import { MediaRecorder } from "../../packages/webrtc/src/nonstandard";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const recorder = new MediaRecorder({
    path: `./vp8-${Date.now()}.webm`,
    numOfTracks: 2,
    width: 640,
    height: 360,
    // roll: 90,
  });

  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [useNACK(), usePLI(), useREMB()],
        }),
      ],
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        }),
      ],
    },
    headerExtensions: { video: [useVideoOrientation()] },
  });

  pc.addTransceiver("video").onTrack.subscribe(async (track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 3_000);
    await recorder.addTrack(track);
    track.onReceiveRtp.subscribe((rtp, extensions) => {
      if (extensions) {
        const orientation = extensions[
          RTP_EXTENSION_URI.videoOrientation
        ] as videoOrientationPayload;
        if (orientation) {
          console.log("orientation", orientation);
        }
      }
    });
  });

  pc.addTransceiver("audio").onTrack.subscribe(async (track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    await recorder.addTrack(track);
  });

  setTimeout(async () => {
    await recorder.stop();
    console.log("stop");
  }, 5_000);

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
