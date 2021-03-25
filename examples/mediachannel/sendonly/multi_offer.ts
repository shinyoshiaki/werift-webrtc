import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { createSocket } from "dgram";

const server = new Server({ port: 8888 });
console.log("start");
const udp1 = createSocket("udp4");
udp1.bind(5000);
const udp2 = createSocket("udp4");
udp2.bind(5001);

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [],
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
        }),
      ],
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  const track1 = new MediaStreamTrack({ kind: "video" });
  pc.addTransceiver(track1, "sendonly");
  const track2 = new MediaStreamTrack({ kind: "video" });
  pc.addTransceiver(track2, "sendonly");

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  await pc.connectionStateChange.watch((state) => state === "connected");
  udp1.on("message", (data) => {
    track1.writeRtp(data);
  });
  udp2.on("message", (data) => {
    track2.writeRtp(data);
  });
});
