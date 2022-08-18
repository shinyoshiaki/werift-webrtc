import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { createSocket } from "dgram";

const udp = createSocket("udp4");
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
          // parameters: { usedtx: 1 },
        }),
      ],
    },
  });

  pc.addTransceiver("audio", { direction: "recvonly" }).onTrack.subscribe(
    (track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        udp.send(rtp.serialize(), 4005);
      });
    }
  );

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
