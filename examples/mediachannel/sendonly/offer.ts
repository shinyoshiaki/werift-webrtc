import {
  MediaStreamTrack,
  randomPort,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { createSocket } from "dgram";
import { spawn } from "child_process";

const server = new Server({ port: 8888 });
console.log("start");

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

  const track = new MediaStreamTrack({ kind: "video" });
  randomPort().then((port) => {
    const udp = createSocket("udp4");
    udp.bind(port);

    const args = [
      `videotestsrc`,
      "video/x-raw,width=640,height=480,format=I420",
      "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
      "rtpvp8pay",
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");

    spawn("gst-launch-1.0", args.split(" "));
    udp.on("message", (data) => {
      const rtp = RtpPacket.deSerialize(data);
      track.writeRtp(rtp);
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
