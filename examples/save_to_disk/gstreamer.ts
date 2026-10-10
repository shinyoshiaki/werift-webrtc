import { spawn } from "child_process";
import { createSocket } from "dgram";
import { Server } from "ws";
import { RTCPeerConnection, randomPorts } from "../../packages/webrtc/src";

(async () => {
  const [videoPort, audioPort] = await randomPorts(2);
  const gstArgs = [
    "-e",
    "udpsrc",
    "name=videoRTP",
    `port=${videoPort}`,
    "caps",
    "=",
    "application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)VP8, payload=(int)97",
    "!",
    "queue",
    "!",
    "rtpvp8depay",
    "!",
    "queue",
    "!",
    "muxer.video_0",
    "udpsrc",
    `port=${audioPort}`,
    "caps",
    "=",
    "application/x-rtp, media=(string)audio, clock-rate=(int)48000, encoding-name=(string)OPUS, payload=(int)96",
    "!",
    "queue",
    "!",
    "rtpopusdepay",
    "!",
    "opusdec",
    "!",
    "opusenc",
    "!",
    "queue",
    "!",
    "muxer.audio_0",
    "webmmux",
    'name="muxer"',
    "!",
    "filesink",
    "location=capture.webm",
  ];

  console.log(`gst-launch-1.0 ${gstArgs.join(" ")}`);
  const gst = spawn("gst-launch-1.0", gstArgs);

  gst.stdout?.on("data", (data) => console.log(data.toString()));
  gst.stderr?.on("data", (data) =>
    console.error(`gst stderr: ${data.toString()}`),
  );
  let shuttingDown = false;
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
      console.log(`gst exit code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (unexpected) {
        console.error(
          `gst unexpected exit code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
        process.exitCode = 1;
      }
      resolve({ code, signal, unexpected });
    });
  });

  const stopGst = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    gst.kill("SIGINT");
    void (async () => {
      const result = await Promise.race([
        gstExit,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 2_000);
          timer.unref();
        }),
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
  };
  process.on("SIGINT", stopGst);
  process.on("SIGTERM", stopGst);

  const udp = createSocket("udp4");
  const server = new Server({ port: 8878 });
  console.log("start");

  server.on("connection", async (socket) => {
    const pc = new RTCPeerConnection({});

    {
      const transceiver = pc.addTransceiver("video");
      transceiver.onTrack.subscribe((track) => {
        transceiver.sender.replaceTrack(track);
        track.onReceiveRtp.subscribe((rtp) => {
          udp.send(rtp.serialize(), videoPort, "127.0.0.1");
        });
        track.onReceiveRtp.once(() => {
          setInterval(() => transceiver.receiver.sendRtcpPLI(track.ssrc), 2000);
        });
      });
    }
    {
      const transceiver = pc.addTransceiver("audio");
      transceiver.onTrack.subscribe((track) => {
        transceiver.sender.replaceTrack(track);
        track.onReceiveRtp.subscribe((rtp) => {
          udp.send(rtp.serialize(), audioPort, "127.0.0.1");
        });
      });
    }

    await pc.setLocalDescription(await pc.createOffer());
    const sdp = JSON.stringify(pc.localDescription);
    socket.send(sdp);

    socket.on("message", (data: any) => {
      pc.setRemoteDescription(JSON.parse(data));
    });
  });
})();
