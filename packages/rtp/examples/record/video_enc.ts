import { spawn } from "child_process";
import { createSocket } from "dgram";
import { appendFile, open, stat, unlink, writeFile } from "fs/promises";

import {
  AvBufferCallback,
  DepacketizeCallback,
  DurationPosition,
  JitterBufferCallback,
  PromiseQueue,
  randomPort,
  replaceSegmentSize,
  RtpSourceCallback,
  SegmentSizePosition,
  WebmCallback,
} from "../../src";

const path = "./webm_enc.webm";

console.log("start");

randomPort().then(async (port) => {
  await unlink(path).catch((e) => e);

  {
    const args = [
      `audiotestsrc  ! audioconvert ! audioresample ! queue ! opusenc`,
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

  const encryptionKey = Buffer.from([
    0xef, 0xac, 0xdf, 0x21, 0xef, 0xbd, 0xaa, 0xe1, 0xd3, 0x81, 0xa4, 0x56,
    0x94, 0xf4, 0x5f, 0x5e,
  ]);
  await writeFile("webm_enc.key", encryptionKey);

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
    { duration: 1000 * 60 * 60 * 24, encryptionKey, strictTimestamp: true }
  );

  const audio = new RtpSourceCallback({ payloadType: 96 });
  {
    const jitterBuffer = new JitterBufferCallback(48000);
    const depacketizer = new DepacketizeCallback("opus");

    audio.pipe((input) => jitterBuffer.input(input));
    jitterBuffer.pipe(depacketizer.input);
    depacketizer.pipe(avBuffer.inputAudio);
    avBuffer.pipeAudio(webm.inputAudio);
  }
  const video = new RtpSourceCallback({ payloadType: 97 });
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

  const queue = new PromiseQueue();
  webm.pipe(async (value) => {
    queue.push(async () => {
      if (value.saveToFile) {
        await appendFile(path, value.saveToFile);
      } else if (value.eol) {
        const { durationElement } = value.eol;
        const handler = await open(path, "r+");
        await handler.write(
          durationElement,
          0,
          durationElement.length,
          DurationPosition
        );
        const meta = await stat(path);
        const resize = replaceSegmentSize(meta.size);
        await handler.write(resize, 0, resize.length, SegmentSizePosition);

        await handler.close();
      }
    });
  });

  setTimeout(() => {
    console.log("stop");
    audio.stop();
    video.stop();
  }, 5_000);
});
