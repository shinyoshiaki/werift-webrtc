import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../../packages/webrtc/src";
import {
  createMp4WebmRegister,
  installPolyfill,
} from "../../../packages/webrtc/src/polyfill";

const server = new Server({ port: 8881 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "goog-remb" },
          ],
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
  });

  installPolyfill({
    mediaRegister: [
      createMp4WebmRegister({
        path: "~/Downloads/test.webm",
        loop: true,
      }),
    ],
  });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });

  if (stream.getAudioTracks()[0]) {
    pc.addTransceiver(stream.getAudioTracks()[0], { direction: "sendonly" });
  }
  if (stream.getVideoTracks()[0]) {
    pc.addTransceiver(stream.getVideoTracks()[0], { direction: "sendonly" });
  }

  pc.connectionStateChange
    .watch((state) => state === "connected")
    .then(() => undefined);

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
