import { spawn } from "child_process";
import { createSocket } from "dgram";
import { appendFile, open, stat, unlink, writeFile } from "fs/promises";
import { ReadableStreamDefaultReadResult } from "stream/web";

import {
  depacketizeTransformer,
  DurationPosition,
  jitterBufferTransformer,
  randomPort,
  replaceSegmentSize,
  RtpSourceStream,
  SegmentSizePosition,
  WebmStream,
  WebmStreamOutput,
} from "../../src";

const path = "./webm_enc.webm";

console.log("start");

randomPort().then(async (port) => {
  await unlink(path).catch((e) => e);

  {
    const args = [
      `videotestsrc`,
      "clockoverlay",
      "video/x-raw,width=640,height=480,format=I420",
      "vp8enc error-resilient=partitions keyframe-max-dist=30 auto-alt-ref=true cpu-used=5 deadline=1",
      "rtpvp8pay pt=96",
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }
  {
    const args = [
      `audiotestsrc wave=ticks ! audioconvert ! audioresample ! queue ! opusenc`,
      `rtpopuspay pt=97`,
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }

  const udp = createSocket("udp4");
  udp.bind(port);
  udp.on("message", (data) => {
    video.push(data);
    audio.push(data);
  });

  const encryptionKey = Buffer.from([
    0xef, 0xac, 0xdf, 0x21, 0xef, 0xbd, 0xaa, 0xe1, 0xd3, 0x81, 0xa4, 0x56,
    0x94, 0xf4, 0x5f, 0x5e,
  ]);
  await writeFile("webm_enc.key", encryptionKey);

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
      {
        kind: "audio",
        codec: "OPUS",
        clockRate: 48000,
        trackNumber: 2,
      },
    ],
    { duration: 1000 * 60 * 60 * 24, encryptionKey }
  );

  const video = new RtpSourceStream({ payloadType: 96 });
  video.readable
    .pipeThrough(jitterBufferTransformer(90000))
    .pipeThrough(
      depacketizeTransformer("vp8", {
        isFinalPacketInSequence: (h) => h.marker,
      })
    )
    .pipeTo(webm.videoStream);

  const audio = new RtpSourceStream({ payloadType: 97 });
  audio.readable
    .pipeThrough(jitterBufferTransformer(48000))
    .pipeThrough(depacketizeTransformer("opus"))
    .pipeTo(webm.audioStream);

  const reader = webm.webmStream.getReader();
  const readChunk = async ({
    value,
    done,
  }: ReadableStreamDefaultReadResult<WebmStreamOutput>) => {
    if (done) return;

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

    reader.read().then(readChunk);
  };
  reader.read().then(readChunk);

  setTimeout(() => {
    console.log("stop");
    video.stop();
    audio.stop();
  }, 10_000);
});
