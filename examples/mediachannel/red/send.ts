import { spawn } from "child_process";
import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  randomPort,
} from "../../../packages/webrtc/src";
import {
  createRtpRtcpRegister,
  installPolyfill,
} from "../../../packages/webrtc/src/polyfill";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/RED",
          clockRate: 48000,
          channels: 2,
        }),
        new RTCRtpCodecParameters({
          mimeType: "audio/OPUS",
          clockRate: 48000,
          channels: 2,
        }),
      ],
    },
  });

  const port = await randomPort();
  installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({
        mimeType: "audio/opus",
        udp: { port },
        clockRate: 48000,
        channels: 2,
      }),
    ],
  });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  if (track) {
    pc.addTransceiver(track, { direction: "sendonly" });
  }

  const args = [
    `audiotestsrc wave=ticks ! audioconvert ! audioresample ! queue ! opusenc ! rtpopuspay`,
    `udpsink host=127.0.0.1 port=${port}`,
  ].join(" ! ");
  console.log(args);
  spawn("gst-launch-1.0", args.split(" "));

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
