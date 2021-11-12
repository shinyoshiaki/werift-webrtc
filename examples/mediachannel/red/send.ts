import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { OpusEncoder } from "@discordjs/opus";
import Speaker from "speaker";

const encoder = new OpusEncoder(48000, 2);
const speaker = new Speaker({ channels: 2, sampleRate: 48000 });
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
        const decoded = encoder.decode(rtp.payload);
        speaker.write(decoded);
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
