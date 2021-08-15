import {
  BufferResolve,
  getUserMp4,
  LipSync,
  randomPort,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtcpSrPacket,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { spawn } from "child_process";
import { createSocket } from "dgram";
import { setTimeout } from "timers/promises";

console.log("start");

const sender = new Server({ port: 8887 });
sender.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/h264",
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

const receiver = new Server({ port: 8888 });
receiver.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/h264",
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
  const audioSync = new LipSync(48000);
  const videoSync = new LipSync(90000);

  const audioPort = await randomPort();
  {
    const args = [
      `udpsrc port=${audioPort} caps = "application/x-rtp, media=(string)audio, clock-rate=(int)48000, encoding-name=(string)OPUS, payload=(int)96"`,
      "rtpjitterbuffer latency=2000",
      "rtpopusdepay",
      "opusdec",
      "audioconvert",
      `audioresample`,
      `autoaudiosink`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }
  const videoPort = await randomPort();
  {
    const args = [
      `udpsrc port=${videoPort} caps = "application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)H264, payload=(int)97"`,
      "rtpjitterbuffer latency=2000",
      "rtph264depay",
      "decodebin",
      "videoconvert",
      `autovideosink`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }

  const udp = createSocket("udp4");

  const audio = pc.addTransceiver("audio", { direction: "recvonly" });
  audio.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(async (rtp) => {
      await setTimeout(1000);
      udp.send(rtp.serialize(), audioPort, "127.0.0.1");
    });
  });
  audio.receiver.onRtcp.subscribe((rtcp) => {
    if (rtcp.type === RtcpSrPacket.type) {
      audioSync.srReceived(rtcp);
    }
  });

  const video = pc.addTransceiver("video", { direction: "recvonly" });
  video.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      udp.send(rtp.serialize(), videoPort, "127.0.0.1");
    });
  });
  video.receiver.onRtcp.subscribe((rtcp) => {
    if (rtcp.type === RtcpSrPacket.type) {
      videoSync.srReceived(rtcp);
    }
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
