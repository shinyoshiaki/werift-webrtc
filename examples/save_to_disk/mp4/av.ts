import {
  DepacketizeCallback,
  JitterBufferCallback,
  LipsyncCallback,
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
      kind: "audio",
      codec: "opus",
      clockRate: 48000,
      trackNumber: 1,
    },
    {
      width: 640,
      height: 360,
      kind: "video",
      codec: "avc1",
      clockRate: 90000,
      trackNumber: 2,
    },
  ]);
  await unlink(output).catch(() => {});
  mp4.pipe(MP4Callback.saveToFileSystem(output));

  const audio = new RtpSourceCallback();
  const video = new RtpSourceCallback();
  const audioRtcp = new RtcpSourceCallback();
  const videoRtcp = new RtcpSourceCallback();

  {
    const depacketizer = new DepacketizeCallback("opus");
    const ntpTime = new NtpTimeCallback(48000);

    audio.pipe(ntpTime.input);
    audioRtcp.pipe(ntpTime.input);

    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(mp4.inputAudio);
  }
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
    track.onReceiveRtp.once(() => {
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 2_000);
    });
  });
  pc.addTransceiver("audio").onTrack.subscribe((track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    track.onReceiveRtp.subscribe((rtp) => {
      audio.input(rtp);
    });
    track.onReceiveRtcp.once((rtcp) => {
      audioRtcp.input(rtcp);
    });
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
    audio.stop();
    video.stop();
    await pc.close();
  }, 60_000);
});
