import { spawn } from "child_process";
import { createSocket } from "dgram";
import { appendFile, open, unlink } from "fs/promises";
import { ReadableStreamDefaultReadResult } from "stream/web";

import {
  depacketizeTransformer,
  jitterBufferTransformer,
  randomPort,
  RtpPacket,
  RtpSourceStream,
  WebmLiveOutput,
  WebmStream,
} from "../../src";

const path = "./webmLive.webm";

console.log("start");

randomPort().then(async (port) => {
  await unlink(path);

  const args = [
    `videotestsrc`,
    "clockoverlay",
    "video/x-raw,width=640,height=480,format=I420",
    "vp8enc error-resilient=partitions keyframe-max-dist=30 auto-alt-ref=true cpu-used=5 deadline=1",
    "rtpvp8pay",
    `udpsink host=127.0.0.1 port=${port}`,
  ].join(" ! ");
  spawn("gst-launch-1.0", args.split(" "));

  const udp = createSocket("udp4");
  udp.bind(port);
  udp.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    source.push(rtp);
  });

  const webm = new WebmStream(
    [
      {
        width: 640,
        height: 480,
        kind: "video",
        codec: "VP8",
        clockRate: 90000,
        trackNumber: 1,
      },
    ],
    { duration: 1000 * 60 * 60 * 24 }
  );

  const source = new RtpSourceStream();
  source.readable
    .pipeThrough(jitterBufferTransformer(90000))
    .pipeThrough(
      depacketizeTransformer("vp8", {
        isFinalPacketInSequence: (h) => h.marker,
      })
    )
    .pipeTo(webm.videoStream);

  const reader = webm.webmStream.getReader();
  const readChunk = async ({
    value,
    done,
  }: ReadableStreamDefaultReadResult<WebmLiveOutput>) => {
    if (done) return;

    if (value.saveToFile) {
      await appendFile(path, value.saveToFile);
    } else if (value.eol) {
      const { durationElement } = value.eol;
      const handler = await open(path, "r+");
      await handler.write(durationElement, 0, durationElement.length, 83);
      await handler.close();
    }

    reader.read().then(readChunk);
  };
  reader.read().then(readChunk);

  setTimeout(() => {
    console.log("stop");
    source.stop();
  }, 5_000);
});
