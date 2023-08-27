import {
  DepacketizeCallback,
  JitterBufferCallback,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpSourceCallback,
  RtpTimeCallback,
  saveToFileSystem,
  WebmCallback,
} from "../../packages/webrtc/src";
import { Server } from "ws";
import { unlink } from "fs/promises";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const output = `./output-${Date.now()}.webm`;
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
          parameters:
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        }),
      ],
    },
  });

  const webm = new WebmCallback(
    [
      {
        width: 640,
        height: 360,
        kind: "video",
        codec: "MPEG4/ISO/AVC",
        clockRate: 90000,
        trackNumber: 1,
      },
    ],
    { duration: 1000 * 60 * 60 }
  );

  const video = new RtpSourceCallback();

  {
    const jitterBuffer = new JitterBufferCallback(90000);
    const time = new RtpTimeCallback(jitterBuffer.clockRate);
    const depacketizer = new DepacketizeCallback("MPEG4/ISO/AVC", {
      isFinalPacketInSequence: (h) => h.marker,
    });

    video.pipe(jitterBuffer.input);
    jitterBuffer.pipe(time.input);
    time.pipe(depacketizer.input);
    depacketizer.pipe((o) => {
      webm.inputVideo(o);
    });
  }

  await unlink(output).catch(() => {});
  webm.pipe(saveToFileSystem(output));

  pc.addTransceiver("video").onTrack.subscribe((track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    track.onReceiveRtp.subscribe((rtp) => {
      video.input(rtp);
    });

    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    }, 2_000);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  setTimeout(async () => {
    console.log("stop");
    video.stop();
    await pc.close();
  }, 20_000);
});
