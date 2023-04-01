import {
  DepacketizeCallback,
  JitterBufferCallback,
  LipsyncCallback,
  NtpTimeCallback,
  RTCPeerConnection,
  RtcpSourceCallback,
  RtpSourceCallback,
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
  const pc = new RTCPeerConnection();

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
  const video = new RtpSourceCallback();
  const audioRtcp = new RtcpSourceCallback();
  const videoRtcp = new RtcpSourceCallback();
  const lipsync = new LipsyncCallback({
    syncInterval: 1000,
    bufferingTimes: 10,
  });

  {
    const depacketizer = new DepacketizeCallback("opus");
    const ntpTime = new NtpTimeCallback(48000);

    audio.pipe(ntpTime.input);
    audioRtcp.pipe(ntpTime.input);

    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(lipsync.inputAudio);
    lipsync.pipeAudio(webm.inputAudio);
  }
  {
    const jitterBuffer = new JitterBufferCallback(90000);
    const ntpTime = new NtpTimeCallback(90000);
    const depacketizer = new DepacketizeCallback("vp8", {
      isFinalPacketInSequence: (h) => h.marker,
    });

    video.pipe(jitterBuffer.input);
    videoRtcp.pipe(ntpTime.input);

    jitterBuffer.pipe(ntpTime.input);
    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(lipsync.inputVideo);
    lipsync.pipeVideo(webm.inputVideo);
  }

  await unlink(output).catch(() => {});
  webm.pipe(saveToFileSystem(output));

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
    pc.setRemoteDescription(JSON.parse(data));
  });

  setTimeout(async () => {
    console.log("stop");
    audio.stop();
    video.stop();
    await pc.close();
  }, 60_000 * 60 * 2);
});
