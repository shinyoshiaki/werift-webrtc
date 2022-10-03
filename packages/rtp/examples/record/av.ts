import { spawn } from "child_process";
import { createSocket } from "dgram";
import { appendFile, open, unlink } from "fs/promises";
import Event from "rx.mini";
import { ReadableStreamDefaultReadResult } from "stream/web";

import {
  depacketizeTransformer,
  jitterBufferTransformer,
  randomPort,
  RtpPacket,
  RtpSourceStream,
  WebmLiveOutput,
  WebmLiveSink,
} from "../../src";

const onReceiveRtp = new Event<[RtpPacket]>();
const path = "./webmAV.webm";

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
    const rtp = RtpPacket.deSerialize(data);
    onReceiveRtp.execute(rtp);
  });

  const webm = new WebmLiveSink(
    [
      {
        kind: "video",
        codec: "VP8",
        clockRate: 90000,
        trackNumber: 1,
        width: 640,
        height: 480,
      },
      {
        kind: "audio",
        codec: "OPUS",
        clockRate: 48000,
        trackNumber: 2,
      },
    ],
    { duration: 1000 * 60 * 60 * 24 }
  );

  const video = new RtpSourceStream(onReceiveRtp, { payloadType: 96 });
  video.readable
    .pipeThrough(jitterBufferTransformer(90000))
    .pipeThrough(depacketizeTransformer((h) => h.marker, "vp8"))
    .pipeTo(webm.videoStream);

  const audio = new RtpSourceStream(onReceiveRtp, { payloadType: 97 });
  audio.readable
    .pipeThrough(jitterBufferTransformer(48000))
    .pipeThrough(depacketizeTransformer(() => true, "opus"))
    .pipeTo(webm.audioStream);

  const reader = webm.webmStream.getReader();
  const readChunk = async ({
    value,
    done,
  }: ReadableStreamDefaultReadResult<WebmLiveOutput>) => {
    if (done) return;

    if (value.packet) {
      await appendFile(path, value.packet);
    } else if (value.eol) {
      const { durationElement } = value.eol;
      const handler = await open(path, "r+");
      await handler.write(durationElement, 0, durationElement.length, 83);
      await handler.close();
    }
    reader.read().then(readChunk);
  };
  reader.read().then(readChunk);

  setTimeout(async () => {
    await Promise.all([video.stop(), audio.stop()]);
    console.log("stop");
  }, 5_000);
});
