import { spawn } from "child_process";
import { createSocket } from "dgram";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "fs/promises";
import { createServer } from "http";
import path from "path";

import {
  AvBufferCallback,
  DepacketizeCallback,
  JitterBufferCallback,
  PromiseQueue,
  randomPort,
  RtpSourceCallback,
  WebmCallback,
} from "../../rtp/src";
import { MPD } from "../src";

// ngrok http 8125

const dir = "./dash";
const serverPort = 8125;

console.log("start", serverPort);

const mpd = new MPD({
  codecs: ["vp8", "opus"],
  minBufferTime: 5,
  minimumUpdatePeriod: 1,
});

const server = createServer();
server.on("request", async (req, res) => {
  const filePath = dir + req.url;
  console.log("req", filePath);

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = { ".mpd": "application/dash+xml", ".webm": "video/webm" };

  if (extname === ".mpd") {
    await writeFile(dir + "/dash.mpd", mpd.build());
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Request-Method", "*");
  res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "*");

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname] });
    res.end(file);
  } catch (error) {
    res.writeHead(404);
    res.end();
  }
});
server.listen(serverPort);

randomPort().then(async (port) => {
  await rm(dir, { recursive: true }).catch((e) => e);
  await mkdir(dir).catch((e) => e);

  await writeFile(dir + "/dash.mpd", mpd.build());

  {
    const args = [
      `audiotestsrc wave=ticks ! audioconvert ! audioresample ! queue ! opusenc`,
      `rtpopuspay pt=96`,
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }
  {
    const args = [
      `videotestsrc`,
      "clockoverlay",
      "video/x-raw,width=640,height=480,format=I420",
      "vp8enc error-resilient=partitions keyframe-max-dist=30 auto-alt-ref=true cpu-used=5 deadline=1",
      "rtpvp8pay pt=97",
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }
  const udp = createSocket("udp4");
  udp.bind(port);
  udp.on("message", (data) => {
    audio.input(data);
    video.input(data);
  });

  const avBuffer = new AvBufferCallback();
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
        height: 480,
        kind: "video",
        codec: "VP8",
        clockRate: 90000,
        trackNumber: 2,
      },
    ],
    { duration: 1000 * 60 * 60 * 24, strictTimestamp: true }
  );

  const audio = new RtpSourceCallback({
    payloadType: 96,
  });
  const video = new RtpSourceCallback({
    payloadType: 97,
  });

  {
    const jitterBuffer = new JitterBufferCallback(48000);
    const depacketizer = new DepacketizeCallback("opus");

    audio.pipe((input) => jitterBuffer.input(input));
    jitterBuffer.pipe(depacketizer.input);
    depacketizer.pipe(avBuffer.inputAudio);
    avBuffer.pipeAudio(webm.inputAudio);
  }
  {
    const jitterBuffer = new JitterBufferCallback(90000);
    const depacketizer = new DepacketizeCallback("vp8", {
      isFinalPacketInSequence: (h) => h.marker,
    });

    video.pipe((input) => jitterBuffer.input(input));
    jitterBuffer.pipe(depacketizer.input);
    depacketizer.pipe(avBuffer.inputVideo);
    avBuffer.pipeVideo(webm.inputVideo);
  }

  let timestamp = 0;
  const queue = new PromiseQueue();
  webm.pipe(async (value) => {
    queue.push(async () => {
      if (value.saveToFile && value.kind) {
        switch (value.kind) {
          case "initial":
            {
              await writeFile(dir + "/init.webm", value.saveToFile);
            }
            break;
          case "cluster":
            {
              if (value.previousDuration! > 0) {
                mpd.segmentationTimeLine.push({
                  d: value.previousDuration!,
                  t: timestamp,
                });
                await writeFile(dir + "/dash.mpd", mpd.build());
                await rename(
                  dir + "/cluster.webm",
                  dir + `/media${timestamp}.webm`
                );
                timestamp += value.previousDuration!;
              }
              await writeFile(dir + `/cluster.webm`, value.saveToFile);
            }
            break;
          case "block":
            {
              await appendFile(dir + `/cluster.webm`, value.saveToFile);
            }
            break;
        }
      }
    });
  });
});
