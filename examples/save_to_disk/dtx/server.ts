import {
  DepacketizeCallback,
  DtxCallback,
  NtpTimeCallback,
  RTCPeerConnection,
  RtcpSourceCallback,
  RTCRtpCodecParameters,
  RtpSourceCallback,
  saveToFileSystem,
  WebmCallback,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { unlink } from "fs/promises";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

const silent = Buffer.from([0xf8, 0xff, 0xfe]);

server.on("connection", async (socket) => {
  const output = `./output-${Date.now()}.webm`;
  console.log("connected", output);
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
          parameters: "usedtx=1",
        }),
      ],
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
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
  pc.connectionStateChange.subscribe((state) => {
    console.log("connectionStateChange", state);
  });

  const webm = new WebmCallback(
    [
      {
        kind: "audio",
        codec: "OPUS",
        clockRate: 48000,
        trackNumber: 1,
      },
      {
        width: 640,
        height: 360,
        kind: "video",
        codec: "VP8",
        clockRate: 90000,
        trackNumber: 2,
      },
    ],
    { duration: 1000 * 60 * 60 }
  );

  const audio = new RtpSourceCallback();
  const audioRtcp = new RtcpSourceCallback();
  {
    const ntpTime = new NtpTimeCallback(48000);
    const depacketizer = new DepacketizeCallback("opus");
    const dtx = new DtxCallback(20, silent);

    audio.pipe(ntpTime.input);
    audioRtcp.pipe(ntpTime.input);
    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(dtx.input);
    dtx.pipe(webm.inputAudio);
    // depacketizer.pipe(webm.inputAudio);
  }
  const video = new RtpSourceCallback();
  const videoRtcp = new RtcpSourceCallback();
  {
    const ntpTime = new NtpTimeCallback(90000);
    const depacketizer = new DepacketizeCallback("vp8", {
      isFinalPacketInSequence: (h) => h.marker,
    });

    video.pipe(ntpTime.input);
    videoRtcp.pipe(ntpTime.input);
    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(webm.inputVideo);
  }

  await unlink(output).catch(() => {});
  webm.pipe(saveToFileSystem(output));

  pc.addTransceiver("audio", { direction: "recvonly" }).onTrack.subscribe(
    (track) => {
      track.onReceiveRtp.subscribe(audio.input);
      track.onReceiveRtcp.subscribe(audioRtcp.input);
    }
  );
  pc.addTransceiver("video", { direction: "recvonly" }).onTrack.subscribe(
    (track) => {
      track.onReceiveRtp.subscribe(video.input);
      track.onReceiveRtcp.subscribe(videoRtcp.input);
    }
  );

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    const msg = JSON.parse(data);
    if (msg.candidate) {
      pc.addIceCandidate(msg);
    } else {
      pc.setRemoteDescription(msg);
    }
  });

  setTimeout(async () => {
    console.log("stop");
    audio.stop();
    video.stop();
    await pc.close();
  }, 10_000);
});
