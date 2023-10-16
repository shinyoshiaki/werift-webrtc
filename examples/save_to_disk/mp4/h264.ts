import {
  annexb2avcc,
  Container,
  DepacketizeCallback,
  JitterBufferCallback,
  NtpTimeCallback,
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

  const container = new Container();

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
    depacketizer.pipe(({ frame }) => {
      if (frame) {
        if (!container.videoTrack) {
          if (frame.isKeyframe) {
            const avcc = annexb2avcc(frame.data);
            container.write({
              codec: "avc1",
              codedHeight: 480,
              codedWidth: 640,
              description: avcc.buffer,
              displayAspectHeight: 3,
              displayAspectWidth: 4,
              track: "video",
            });
            container.write({
              byteLength: frame.data.length,
              duration: null,
              timestamp: frame.time * 1000,
              type: "key",
              copyTo: (destination: Uint8Array) => {
                frame.data.copy(destination);
              },
              track: "video",
            });
          }
        } else {
          container.write({
            byteLength: frame.data.length,
            duration: null,
            timestamp: frame.time * 1000,
            type: frame.isKeyframe ? "key" : "delta",
            copyTo: (destination: Uint8Array) => {
              frame.data.copy(destination);
            },
            track: "video",
          });
        }
      }
    });
  }

  await unlink(output).catch(() => {});

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
    pc.setRemoteDescription(JSON.parse(data));
  });

  setTimeout(async () => {
    console.log("stop");
    video.stop();
    await pc.close();
  }, 10_000);

  const queue = new PromiseQueue();
  container.onData.subscribe(async (value) => {
    await queue.push(async () => {
      await appendFile(output, value.data);
    });
  });
});
