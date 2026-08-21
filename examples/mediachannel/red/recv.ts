import { createSocket } from "dgram";
import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  uint16Add,
} from "../../../packages/webrtc/src";

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
      // Probe padding shares the media RTP sequence space. Skipping it without
      // compacting seq looks like loss to the next jitterbuffer.
      let skippedPadding = 0;
      track.onReceiveRtp.subscribe((rtp, _extensions, info) => {
        // GCC probe padding is padding-only RTP; do not forward hop-local probes.
        if (info?.type === "padding") {
          skippedPadding = uint16Add(skippedPadding, 1);
          return;
        }
        const forwarded = rtp.clone();
        forwarded.header.sequenceNumber = uint16Add(
          forwarded.header.sequenceNumber,
          -skippedPadding,
        );
        udp.send(forwarded.serialize(), 4005);
      });
    },
  );

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
