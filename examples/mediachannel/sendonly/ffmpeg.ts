import { exec } from "child_process";
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

// open answer.html

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const payloadType = 96;
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [],
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: payloadType,
        }),
      ],
    },
  });

  const port = await randomPort();
  installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({
        mimeType: "video/VP8",
        udp: { port },
        payloadType,
      }),
    ],
  });
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  if (track) {
    pc.addTransceiver(track, { direction: "sendonly" });
  }

  exec(
    `ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=30 -vcodec libvpx -cpu-used 5 -deadline 1 -g 10 -error-resilient 1 -auto-alt-ref 1 -f rtp rtp://127.0.0.1:${port}`,
  );

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
