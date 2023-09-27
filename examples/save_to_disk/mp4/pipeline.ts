import {
  buffer2ArrayBuffer,
  Container,
  DepacketizeCallback,
  JitterBufferCallback,
  LipsyncCallback,
  NtpTimeCallback,
  RTCPeerConnection,
  RtcpSourceCallback,
  RTCRtpCodecParameters,
  RtpSourceCallback,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { appendFile, unlink } from "fs/promises";
import { ReadableStreamDefaultReadResult } from "stream/web";

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
  const video = new RtpSourceCallback();
  const audioRtcp = new RtcpSourceCallback();
  const videoRtcp = new RtcpSourceCallback();
  const lipsync = new LipsyncCallback({
    syncInterval: 2000,
    bufferLength: 5,
    // fillDummyAudioPacket: Buffer.from([0xf8, 0xff, 0xfe]),
  });

  {
    const depacketizer = new DepacketizeCallback("opus");
    const ntpTime = new NtpTimeCallback(48000);

    audio.pipe(ntpTime.input);
    audioRtcp.pipe(ntpTime.input);

    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(lipsync.inputAudio);
    let first = true;
    lipsync.pipeAudio(({ frame }) => {
      if (frame) {
        if (first) {
          const writer = container.encode.writable.getWriter();
          writer.write({
            codec: "opus",
            description: buffer2ArrayBuffer(frame.data),
            numberOfChannels: 2,
            sampleRate: 48000,
          });
          writer.close();
          first = false;
        } else {
          const writer = container.encode.writable.getWriter();
          writer.write({
            byteLength: frame.data.length,
            duration: null,
            timestamp: frame.time,
            type: "key",
            copyTo: (destination: Uint8Array) => {
              frame.data.copy(destination);
            },
          });
          writer.close();
        }
      }
    });
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
    depacketizer.pipe(lipsync.inputVideo);
    let first = true;
    lipsync.pipeVideo(({ frame }) => {
      if (frame) {
        if (first) {
          if (frame.isKeyframe) {
            const writer = container.encode.writable.getWriter();
            writer.write({
              codec: "avc1",
              codedHeight: 480,
              codedWidth: 640,
              description: buffer2ArrayBuffer(frame.data),
              displayAspectHeight: 3,
              displayAspectWidth: 4,
            });
            first = false;
            writer.close();
          } else {
            console.log("skip");
          }
        } else {
          const writer = container.encode.writable.getWriter();
          writer.write({
            byteLength: frame.data.length,
            duration: null,
            timestamp: frame.time,
            type: frame.isKeyframe ? "key" : "delta",
            copyTo: (destination: Uint8Array) => {
              frame.data.copy(destination);
            },
          });
          writer.close();
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
  }, 20_000);

  const reader = container.encode.readable.getReader();
  const readChunk = async ({
    value,
    done,
  }: ReadableStreamDefaultReadResult<any>) => {
    if (done) return;
    if (value) {
      await appendFile(output, value);
    }
    reader.read().then(readChunk);
  };
  reader.read().then(readChunk);
});
