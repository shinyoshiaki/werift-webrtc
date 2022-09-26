import {
  randomPort,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useNACK,
  usePLI,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { spawn } from "child_process";
import { createSocket } from "dgram";

// open ./answer.html

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [useNACK(), usePLI()],
        }),
      ],
    },
  });

  const udp = createSocket("udp4");
  const port = await randomPort();

  pc.addTransceiver("video").onTrack.subscribe((track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    track.onReceiveRtp.subscribe((rtp) => {
      udp.send(rtp.serialize(), port);
    });

    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 5000);
  });

  const args = [
    `udpsrc port=${port}`,
    "application/x-rtp, media=video, encoding-name=VP8, clock-rate=90000, payload=96",
    "rtpjitterbuffer",
    "rtpvp8depay wait-for-keyframe=true",
    "webmmux",
    `filesink location=./gst.webm`,
  ].join(" ! ");
  const process = spawn("gst-launch-1.0", args.split(" "));

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  setTimeout(() => {
    process.kill("SIGINT");
    console.log("stop");
  }, 15_000);
});
