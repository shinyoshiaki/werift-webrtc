import {
  BufferResolve,
  LipSync,
  randomPort,
  RTCPeerConnection,
  useAbsSendTime,
  useSdesMid,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { RtcpSrPacket } from "../../../e2e/lib";
import { spawn } from "child_process";
import { createSocket } from "dgram";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesMid(), useAbsSendTime()],
    },
  });
  const lipsync = new LipSync(5000, 48000, 90000);

  const audioPort = await randomPort();
  {
    const args = [
      `udpsrc port=${audioPort} caps = "application/x-rtp, media=(string)audio, clock-rate=(int)48000, encoding-name=(string)OPUS, payload=(int)96"`,
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
      `udpsrc port=${videoPort} caps = "application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)VP8, payload=(int)97"`,
      "rtpvp8depay",
      "decodebin",
      "videoconvert",
      `autovideosink`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }

  const udp = createSocket("udp4");
  lipsync.onBufferResolve.subscribe(({ audio, video }) => {
    const send = (self: BufferResolve, other: BufferResolve, port: number) => {
      const delay =
        self.startAtNtpTime > other.startAtNtpTime
          ? self.startAtNtpTime - other.startAtNtpTime
          : 0;
      setTimeout(() => {
        self.packets.forEach((p) => udp.send(p.serialize(), port, "127.0.0.1"));
      }, delay);
    };
    send(audio, video, audioPort);
    send(video, audio, videoPort);
  });

  const video = pc.addTransceiver("video", { direction: "recvonly" });
  video.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      setTimeout(() => {
        lipsync.video.rtpReceived(rtp);
      }, 1000);
    });
  });
  video.receiver.onRtcp.subscribe((rtcp) => {
    if (rtcp instanceof RtcpSrPacket) {
      lipsync.video.srReceived(rtcp);
    }
  });

  const audio = pc.addTransceiver("audio", { direction: "recvonly" });
  audio.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      lipsync.audio.rtpReceived(rtp);
    });
  });
  audio.receiver.onRtcp.subscribe((rtcp) => {
    if (rtcp instanceof RtcpSrPacket) {
      lipsync.audio.srReceived(rtcp);
    }
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
