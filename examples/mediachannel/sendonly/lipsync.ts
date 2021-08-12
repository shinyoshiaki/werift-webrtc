import { Server } from "ws";
import {
  getUserMp4,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../../packages/webrtc/src";

const server = new Server({ port: 8881 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
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

  const stream = await getUserMp4("~/Downloads/test.mp4", true);

  pc.addTransceiver(stream.audio, { direction: "sendonly" });
  pc.addTransceiver(stream.video, { direction: "sendonly" });

  pc.connectionStateChange
    .watch((state) => state === "connected")
    .then(() => {
      stream.start();
    });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
