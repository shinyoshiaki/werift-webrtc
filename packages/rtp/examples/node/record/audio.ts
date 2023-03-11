import { spawn } from "child_process";
import { createSocket } from "dgram";
import { unlink } from "fs/promises";

import {
  DepacketizeCallback,
  randomPort,
  RtpPacket,
  RtpSourceCallback,
  RtpTimeCallback,
  saveToFileSystem,
  WebmCallback,
} from "../../../src";

const output = "./o.webm";
const input = "./i.mp3";

console.log("start");

randomPort().then(async (port) => {
  await unlink(output).catch((e) => e);

  const args = [
    `filesrc location=${input} ! decodebin ! audioconvert ! audioresample ! queue ! opusenc`,
    `rtpopuspay pt=97`,
    `udpsink host=127.0.0.1 port=${port}`,
  ].join(" ! ");
  spawn("gst-launch-1.0", args.split(" "));

  const udp = createSocket("udp4");
  udp.bind(port);
  udp.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    source.input(rtp);
  });

  const webm = new WebmCallback(
    [
      {
        kind: "audio",
        codec: "OPUS",
        clockRate: 48000,
        trackNumber: 1,
      },
    ],
    { duration: 1000 * 60 * 60 * 24 }
  );

  const source = new RtpSourceCallback();
  const time = new RtpTimeCallback(48000);
  const depacketizer = new DepacketizeCallback("opus");

  source.pipe((input) => time.input(input));
  time.pipe((input) => depacketizer.input(input));
  depacketizer.pipe(webm.inputAudio);
  webm.pipe(saveToFileSystem(output));

  setTimeout(() => {
    console.log("stop");
    source.stop();
  }, 5_000);
});
