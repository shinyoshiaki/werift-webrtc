import {
  DepacketizeCallback,
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
  ]);
  await unlink(output).catch(() => {});
  mp4.pipe(MP4Callback.saveToFileSystem(output));

  const audio = new RtpSourceCallback();
  const audioRtcp = new RtcpSourceCallback();

  {
    const depacketizer = new DepacketizeCallback("opus");
    const ntpTime = new NtpTimeCallback(48000);

    audio.pipe(ntpTime.input);
    audioRtcp.pipe(ntpTime.input);
    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(mp4.inputAudio);
  }

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
    await pc.close();
  }, 10_000);
});
