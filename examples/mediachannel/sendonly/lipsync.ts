import { Server } from "ws";
import { createSocket } from "dgram";
import {
  MediaStreamTrack,
  randomPort,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../../packages/webrtc/src";
import { exec } from "child_process";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
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

  const audioPort = await randomPort();
  const videoPort = await randomPort();

  const streamId = "test_lipsync";

  const audioTrack = new MediaStreamTrack({ kind: "audio", streamId });
  pc.addTransceiver(audioTrack, { direction: "sendonly" });

  const videoTrack = new MediaStreamTrack({ kind: "video", streamId });
  pc.addTransceiver(videoTrack, { direction: "sendonly" });

  const audio = createSocket("udp4");
  audio.bind(audioPort);
  audio.on("message", (buf) => {
    audioTrack.writeRtp(buf);
  });

  const video = createSocket("udp4");
  video.bind(videoPort);
  video.on("message", (buf) => {
    videoTrack.writeRtp(buf);
  });

  pc.connectionStateChange
    .watch((state) => state === "connected")
    .then(() => {
      const loop = () => {
        const cmd = `gst-launch-1.0 filesrc location= ~/Downloads/test.mp4 ! qtdemux name=d ! \
        queue ! h264parse ! rtph264pay config-interval=10 pt=96 ! udpsink host=127.0.0.1 port=${videoPort} d. ! \
        queue ! aacparse ! avdec_aac ! audioresample ! audioconvert ! opusenc ! rtpopuspay pt=97 ! udpsink host=127.0.0.1 port=${audioPort} -v`;
        const process = exec(cmd);
        process.on("close", () => {
          loop();
        });
      };
      loop();
    });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
