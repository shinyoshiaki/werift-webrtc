import { unlink, writeFile } from "fs/promises";
import type { ReadableStreamDefaultReadResult } from "stream/web";

import { getUserMedia } from "../../../webrtc/src";
import {
  depacketizeTransformer,
  jitterBufferTransformer,
  RtpSourceStream,
  saveToFileSystem,
  WebmStream,
  type WebmStreamOutput,
} from "../../src";

const path = "./webm_enc_video.webm";

console.log("start");

(async () => {
  await unlink(path).catch((e) => e);

  const stream = await getUserMedia("bb.webm", true);

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
    {
      duration: 1000 * 60 * 60 * 24,
      encryptionKey,
    }
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

  stream.audio.onReceiveRtp.subscribe((rtp) => {
    audio.push(rtp);
  });
  stream.video.onReceiveRtp.subscribe((rtp) => {
    video.push(rtp);
  });
  stream.start();

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

  setTimeout(() => {
    console.log("stop");
    video.stop();
    audio.stop();
    stream.stop();
  }, 5_000);
})();
