import {
  buffer2ArrayBuffer,
  Container,
  DepacketizeCallback,
  NtpTimeCallback,
  OpusRtpPayload,
  PromiseQueue,
  RTCPeerConnection,
  RtcpSourceCallback,
  RTCRtpCodecParameters,
  RtpSourceCallback,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { appendFile, unlink } from "fs/promises";

// open ./answer.html

const server = new Server({ port: 8878 });
console.log("start");

server.on("connection", async (socket) => {
  const output = `./original.m4a`;
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

  const container = new Container();

  const audio = new RtpSourceCallback();
  const audioRtcp = new RtcpSourceCallback();

  {
    const depacketizer = new DepacketizeCallback("opus");
    const ntpTime = new NtpTimeCallback(48000);

    audio.pipe(ntpTime.input);
    audioRtcp.pipe(ntpTime.input);
    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(({ frame }) => {
      if (frame) {
        if (!container.track) {
          container.write({
            codec: "opus",
            description: buffer2ArrayBuffer(
              OpusRtpPayload.createCodecPrivate()
            ),
            numberOfChannels: 2,
            sampleRate: 48000,
          });
        } else {
          container.write({
            byteLength: frame.data.length,
            duration: null,
            timestamp: frame.time * 1000,
            type: "key",
            copyTo: (destination: Uint8Array) => {
              frame.data.copy(destination);
            },
          });
        }
      }
    });
  }

  await unlink(output).catch(() => {});

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
    await pc.close();
  }, 5_000);

  const queue = new PromiseQueue();
  container.onData.subscribe(async (value) => {
    await queue.push(async () => {
      await appendFile(output, value.data);
    });
  });
});
