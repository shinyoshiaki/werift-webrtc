import {
  getUserMedia,
  randomPorts,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtcpSrPacket,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { exec } from "child_process";
import { createSocket } from "dgram";
import { setTimeout } from "timers/promises";

console.log("start", __dirname);

new Server({ port: 8887 }).on("connection", async (socket) => {
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

  const stream = await getUserMedia("~/Downloads/test.mp4", true);

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

new Server({ port: 8888 }).on("connection", async (socket) => {
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

  const audioPt = 111;
  const videoPt = 125;
  const audioSsrc = 445566;
  const videoSsrc = 112233;
  const [audioRtp, audioRtcp, videoRtp, videoRtcp] = await randomPorts(4);

  const cmd = `
gst-launch-1.0 -v \
rtpbin name=rtpbin rtp-profile=avpf ntp-time-source=ntp rtcp-sync-send-time=false buffer-mode=synced latency=2000 max-rtcp-rtp-time-diff=2000 \
udpsrc address=127.0.0.1 port=${audioRtp} caps="application/x-rtp, media=audio, encoding-name=OPUS, clock-rate=48000" ! rtpbin.recv_rtp_sink_0 \
udpsrc address=127.0.0.1 port=${audioRtcp} caps="application/x-rtcp" ! rtpbin.recv_rtcp_sink_0 \
udpsrc address=127.0.0.1 port=${videoRtp} caps="application/x-rtp, media=video, encoding-name=H264, clock-rate=90000" ! rtpbin.recv_rtp_sink_1 \
udpsrc address=127.0.0.1 port=${videoRtcp} caps="application/x-rtcp" ! rtpbin.recv_rtcp_sink_1 \
rtpbin. ! rtpopusdepay ! queue ! opusdec ! autoaudiosink sync=true \
rtpbin. ! rtph264depay ! queue ! decodebin ! autovideosink sync=true
`;

  console.log(cmd);
  exec(cmd);
  const udp = createSocket("udp4");

  const audio = pc.addTransceiver("audio", { direction: "recvonly" });
  audio.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(async (rtp) => {
      rtp.header.payloadType = audioPt;
      rtp.header.ssrc = audioSsrc;
      await setTimeout(1000);
      udp.send(rtp.serialize(), audioRtp, "127.0.0.1");
    });
  });
  audio.receiver.onRtcp.subscribe((rtcp) => {
    if (rtcp.type === RtcpSrPacket.type) {
      rtcp.ssrc = audioSsrc;
    }
    udp.send(rtcp.serialize(), audioRtcp, "127.0.0.1");
  });

  const video = pc.addTransceiver("video", { direction: "recvonly" });
  video.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      rtp.header.payloadType = videoPt;
      rtp.header.ssrc = videoSsrc;
      udp.send(rtp.serialize(), videoRtp, "127.0.0.1");
    });
  });
  video.receiver.onRtcp.subscribe((rtcp) => {
    if (rtcp.type === RtcpSrPacket.type) {
      rtcp.ssrc = videoSsrc;
    }
    udp.send(rtcp.serialize(), videoRtcp, "127.0.0.1");
  });

  await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify(pc.localDescription));

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
