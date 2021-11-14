import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  MediaStreamTrack,
  randomPort,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { createSocket } from "dgram";
import { spawn } from "child_process";

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

  const track = new MediaStreamTrack({ kind: "audio" });
  randomPort().then((port) => {
    const udp = createSocket("udp4");
    udp.bind(port);

    const args = [
      `audiotestsrc wave=ticks ! audioconvert ! audioresample ! queue ! opusenc ! rtpopuspay`,
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");
    console.log(args);
    spawn("gst-launch-1.0", args.split(" "));
    udp.on("message", (data) => {
      track.writeRtp(data);
    });
  });
  pc.addTransceiver(track, { direction: "sendonly" });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
