import {
  DepacketizeCallback,
  JitterBufferCallback,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpSourceCallback,
  saveToFileSystem,
  WebmCallback,
} from "../../packages/webrtc/src";
import { Server } from "ws";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/AV1X",
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

  const audio = new RtpSourceCallback();
  const video = new RtpSourceCallback();

  const webm = new WebmCallback([
    {
      width: 640,
      height: 360,
      kind: "video",
      codec: "AV1",
      clockRate: 90000,
      trackNumber: 1,
    },
    {
      kind: "audio",
      codec: "OPUS",
      clockRate: 48000,
      trackNumber: 2,
    },
  ]);

  {
    const depacketizer = new DepacketizeCallback("opus");

    audio.pipe(depacketizer.input);
    depacketizer.pipe(webm.inputAudio);
  }
  {
    const jitterBuffer = new JitterBufferCallback(90000);
    const depacketizer = new DepacketizeCallback("vp8", {
      isFinalPacketInSequence: (h) => h.marker,
    });

    video.pipe(jitterBuffer.input);
    jitterBuffer.pipe(depacketizer.input);
    depacketizer.pipe(webm.inputVideo);
  }

  webm.pipe(saveToFileSystem("./test.webm"));

  setTimeout(() => {
    console.log("stop");
    audio.stop();
    video.stop();
  }, 5_000);

  {
    const transceiver = pc.addTransceiver("video");

    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);
      track.onReceiveRtp.subscribe(video.input);
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 2_000);
    });
  }
  {
    const transceiver = pc.addTransceiver("audio");
    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);
      track.onReceiveRtp.subscribe(audio.input);
    });
  }

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
