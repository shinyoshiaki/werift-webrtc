import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  randomPort,
} from "../../../../packages/webrtc/src";
import { Server } from "ws";
import { spawn } from "child_process";
import { createSocket } from "dgram";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const port = await randomPort();

  const args = [
    `udpsrc port=${port} caps = "application/x-rtp, media=(string)audio, clock-rate=(int)48000, encoding-name=(string)OPUS, payload=(int)96"`,
    "rtpopusdepay",
    "opusparse",
    "webmmux",
    `filesink location=./${"opus"}.webm`,
  ].join(" ! ");
  console.log(args);

  spawn("gst-launch-1.0", args.split(" "));

  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/red",
          clockRate: 48000,
          channels: 2,
        }),
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        }),
      ],
    },
  });

  const udp = createSocket("udp4");
  const audio = pc.addTransceiver("audio");
  audio.onTrack.subscribe((track) => {
    audio.sender.replaceTrack(track);
    // const jitterBuffer = new JitterBuffer({ rtpStream: track.onReceiveRtp });
    // jitterBuffer.pipe({
    //   pushRtpPackets: (packets) => {
    //     packets.forEach((p) => {
    //       console.log("seq", p.header.sequenceNumber);
    //       udp.send(p.serialize(), port);
    //     });
    //   },
    // });
    track.onReceiveRtp.subscribe((p) => {
      udp.send(p.serialize(), port);
    });

    setTimeout(() => {
      process.exit();
    }, 7_000);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
