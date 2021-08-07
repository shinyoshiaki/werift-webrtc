import { Server } from "ws";
import { createSocket } from "dgram";
import {
  MediaStreamTrack,
  randomPort,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RTCRtpTransceiver,
  RtpPacket,
} from "../../../packages/webrtc/src";
import { exec } from "child_process";
import { setTimeout } from "timers/promises";

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

  const audioTrack = new MediaStreamTrack({
    kind: "audio",
    streamId,
  });
  const audioTransceiver = pc.addTransceiver(audioTrack, {
    direction: "sendonly",
  });

  const videoTrack = new MediaStreamTrack({
    kind: "video",
    streamId,
  });
  const videoTransceiver = pc.addTransceiver(videoTrack, {
    direction: "sendonly",
  });

  const registerRtp = (
    port: number,
    transceiver: RTCRtpTransceiver,
    track: MediaStreamTrack
  ) => {
    let payloadType = 0;

    const socket = createSocket("udp4");
    socket.bind(port);
    socket.on("message", async (buf) => {
      const rtp = RtpPacket.deSerialize(buf);
      if (!payloadType) {
        payloadType = rtp.header.payloadType;
      }

      if (payloadType !== rtp.header.payloadType) {
        payloadType = rtp.header.payloadType;
        transceiver.sender.replaceRTP(rtp.header);
      }
      if (track.kind === "audio") await setTimeout(900);
      track.writeRtp(buf);
    });
  };

  registerRtp(audioPort, audioTransceiver, audioTrack);
  registerRtp(videoPort, videoTransceiver, videoTrack);

  pc.connectionStateChange
    .watch((state) => state === "connected")
    .then(() => {
      let payloadType = 96;
      const loop = () => {
        if (payloadType > 100) payloadType = 96;

        const cmd = `gst-launch-1.0 filesrc location= ~/Downloads/test.mp4 ! qtdemux name=d ! \
        queue ! h264parse ! rtph264pay config-interval=10 pt=${payloadType++} ! udpsink host=127.0.0.1 port=${videoPort} d. ! \
        queue ! aacparse ! avdec_aac ! audioresample ! audioconvert ! opusenc ! rtpopuspay pt=${payloadType++} ! udpsink host=127.0.0.1 port=${audioPort}`;
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
