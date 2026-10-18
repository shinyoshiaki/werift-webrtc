import { spawn } from "child_process";
import { createSocket } from "dgram";
import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  randomPort,
} from "../../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const port = await randomPort();

  const gstArgs = [
    "udpsrc",
    `port=${port}`,
    "caps",
    "=",
    "application/x-rtp, media=(string)audio, clock-rate=(int)48000, encoding-name=(string)OPUS, payload=(int)96",
    "!",
    "rtpopusdepay",
    "!",
    "opusparse",
    "!",
    "webmmux",
    "!",
    "filesink",
    "location=./opus.webm",
  ];
  console.log(`gst-launch-1.0 ${gstArgs.join(" ")}`);

  const gst = spawn("gst-launch-1.0", gstArgs);
  let shuttingDown = false;
  gst.stderr?.on("data", (data) =>
    console.error(`gst stderr: ${data.toString()}`),
  );
  gst.on("error", (error) => {
    console.error(`gst error: ${error.message}`);
  });
  const gstExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    unexpected: boolean;
  }>((resolve) => {
    gst.once("exit", (code, signal) => {
      const unexpected = !shuttingDown;
      console.log(
        `gst exit code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (unexpected) {
        console.error(
          `gst unexpected exit: code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
      }
      resolve({ code, signal, unexpected });
    });
  });

  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/red",
          clockRate: 48000,
          channels: 2,
        }),
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        }),
      ],
    },
  });

  const udp = createSocket("udp4");
  const audio = pc.addTransceiver("audio");
  let receivedRtpPackets = 0;
  audio.onTrack.subscribe((track) => {
    audio.sender.replaceTrack(track);
    // const jitterBuffer = new JitterBuffer({ rtpStream: track.onReceiveRtp });
    // jitterBuffer.pipe({
    //   pushRtpPackets: (packets) => {
    //     packets.forEach((p) => {
    //       console.log("seq", p.header.sequenceNumber);
    //       udp.send(p.serialize(), port);
    //     });
    //   },
    // });
    track.onReceiveRtp.subscribe((p) => {
      receivedRtpPackets += 1;
      udp.send(p.serialize(), port);
    });

    setTimeout(() => {
      void (async () => {
        shuttingDown = true;
        console.log(`received RTP packets=${receivedRtpPackets}`);
        gst.kill("SIGINT");
        const result = await Promise.race([
          gstExit,
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 2_000),
          ),
        ]);
        if (!result) {
          console.error("gst shutdown timed out");
          process.exit(1);
          return;
        }
        const success =
          !result.unexpected &&
          (result.code === 0 ||
            (result.code === null && result.signal === "SIGINT"));
        process.exit(success ? 0 : 1);
      })();
    }, 7_000);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
