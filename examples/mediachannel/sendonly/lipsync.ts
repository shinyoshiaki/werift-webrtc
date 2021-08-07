import { Server } from "ws";
import { createSocket } from "dgram";
import {
  MediaStreamTrack,
  randomPort,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
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
  const audioTransceiver = pc.addTransceiver(audioTrack, {
    direction: "sendonly",
  });

  const videoTrack = new MediaStreamTrack({ kind: "video", streamId });
  const videoTransceiver = pc.addTransceiver(videoTrack, {
    direction: "sendonly",
  });

  let audioPayloadType = 0;
  const audio = createSocket("udp4");
  audio.bind(audioPort);
  audio.on("message", (buf) => {
    const rtp = RtpPacket.deSerialize(buf);
    if (!audioPayloadType) {
      audioPayloadType = rtp.header.payloadType;
    }

    if (audioPayloadType !== rtp.header.payloadType) {
      audioPayloadType = rtp.header.payloadType;
      audioTransceiver.sender.replaceRTP(rtp.header);
    }
    audioTrack.writeRtp(buf);
  });

  let videoPayloadType = 0;
  const video = createSocket("udp4");
  video.bind(videoPort);
  video.on("message", (buf) => {
    const rtp = RtpPacket.deSerialize(buf);
    if (!videoPayloadType) {
      videoPayloadType = rtp.header.payloadType;
    }

    if (videoPayloadType !== rtp.header.payloadType) {
      videoPayloadType = rtp.header.payloadType;
      videoTransceiver.sender.replaceRTP(rtp.header);
    }
    videoTrack.writeRtp(buf);
  });

  pc.connectionStateChange
    .watch((state) => state === "connected")
    .then(() => {
      let payloadType = 96;
      const loop = () => {
        if (payloadType > 100) payloadType = 96;

        const cmd = `gst-launch-1.0 filesrc location= ~/Downloads/test.mp4 ! qtdemux name=d ! \
        queue ! h264parse ! rtph264pay config-interval=10 pt=${payloadType++} ! udpsink host=127.0.0.1 port=${videoPort} d. ! \
        queue ! aacparse ! avdec_aac ! audioresample ! audioconvert ! opusenc ! rtpopuspay pt=${payloadType++} ! udpsink host=127.0.0.1 port=${audioPort} -v`;
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
