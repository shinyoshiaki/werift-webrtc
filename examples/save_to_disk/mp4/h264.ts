import {
  DepacketizeCallback,
  JitterBufferCallback,
  NtpTimeCallback,
  RTCPeerConnection,
  RtcpSourceCallback,
  RTCRtpCodecParameters,
  RtpSourceCallback,
  MP4Callback,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { unlink } from "fs/promises";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const output = `./output-${Date.now()}.mp4`;
  console.log("connected", output);
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
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        }),
      ],
    },
  });

  const mp4 = new MP4Callback([
    {
      width: 640,
      height: 360,
      kind: "video",
      codec: "avc1",
      clockRate: 90000,
      trackNumber: 1,
    },
  ]);
  await unlink(output).catch(() => {});
  mp4.pipe(MP4Callback.saveToFileSystem(output));

  const video = new RtpSourceCallback();
  const videoRtcp = new RtcpSourceCallback();

  {
    const jitterBuffer = new JitterBufferCallback(90000);
    const ntpTime = new NtpTimeCallback(jitterBuffer.clockRate);
    const depacketizer = new DepacketizeCallback("MPEG4/ISO/AVC", {
      isFinalPacketInSequence: (h) => h.marker,
    });

    video.pipe(jitterBuffer.input);
    videoRtcp.pipe(ntpTime.input);

    jitterBuffer.pipe(ntpTime.input);
    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(mp4.inputVideo);
  }

  pc.addTransceiver("video").onTrack.subscribe((track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    track.onReceiveRtp.subscribe((rtp) => {
      video.input(rtp);
    });
    track.onReceiveRtcp.once((rtcp) => {
      videoRtcp.input(rtcp);
    });
    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 2_000);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    const message = JSON.parse(data);
    console.log("message", message);
    if (message.sdp) {
      pc.setRemoteDescription(message);
    } else {
      pc.addIceCandidate(message);
    }
  });

  setTimeout(async () => {
    console.log("stop");
    video.stop();
    await pc.close();
  }, 10_000);
});
