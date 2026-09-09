import { Server } from "ws";
import { RTCPeerConnection } from "../../../packages/webrtc/src";
import {
  createMp4WebmRegister,
  installPolyfill,
} from "../../../packages/webrtc/src/polyfill";

const server = new Server({ port: 8881 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection();

  installPolyfill({
    mediaRegister: [
      createMp4WebmRegister({
        path: process.env.WERIFT_EXAMPLE_MEDIA_PATH ?? "~/Downloads/test.webm",
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
