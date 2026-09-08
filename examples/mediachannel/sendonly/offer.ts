import { spawn } from "child_process";
import { Server } from "ws";
import { RTCPeerConnection, randomPort } from "../../../packages/webrtc/src";
import {
  createRtpRtcpRegister,
  installPolyfill,
} from "../../../packages/webrtc/src/polyfill";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection();

  const port = await randomPort();
  installPolyfill({
    mediaRegister: [
      createRtpRtcpRegister({
        mimeType: "video/VP8",
        udp: { port },
        payloadType: 96,
      }),
    ],
  });
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  if (track) {
    pc.addTransceiver(track, { direction: "sendonly" });
  }

  const args = [
    `videotestsrc`,
    "video/x-raw,width=640,height=480,format=I420",
    "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
    "rtpvp8pay",
    `udpsink host=127.0.0.1 port=${port}`,
  ].join(" ! ");
  spawn("gst-launch-1.0", args.split(" "));

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
