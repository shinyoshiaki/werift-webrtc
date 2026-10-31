import { spawn } from "child_process";
import { createSocket } from "dgram";
import { unlink } from "fs/promises";
import type { ReadableStreamDefaultReadResult } from "stream/web";
import { setTimeout } from "timers/promises";

import {
  depacketizeTransformer,
  jitterBufferTransformer,
  randomPort,
  RtpPacket,
  RtpSourceStream,
  saveToFileSystem,
  WebmStream,
  type WebmStreamOutput,
} from "../../src";

const path = "./packet_lost.webm";

console.log("start");

randomPort().then(async (port) => {
  await unlink(path).catch((e) => e);

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
  let index = 0;
  udp.on("message", async (data) => {
    if (index++ % 100 === 0) {
      await setTimeout(200);
    }

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
    .pipeThrough(depacketizeTransformer("vp8", {
        isFinalPacketInSequence: (h) => h.marker,
      }))
    .pipeTo(webm.videoStream);

  const save = saveToFileSystem(path);
  const reader = webm.webmStream.getReader();
  const readChunk = async ({
    value,
    done,
  }: ReadableStreamDefaultReadResult<WebmStreamOutput>) => {
    if (done) return;

    // appends chunks, then fixes Duration / Segment / Cluster sizes on eol
    await save(value);

    reader.read().then(readChunk);
  };
  reader.read().then(readChunk);

  setTimeout(10_000).then(() => {
    console.log("stop");
    source.stop();
  });
});
