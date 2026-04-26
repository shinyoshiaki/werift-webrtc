import { spawn } from "child_process";
import { createSocket } from "dgram";
import { unlink } from "fs/promises";
import { setTimeout } from "timers/promises";

import { randomPort } from "../../src";

const path = "./packet_lost_gst.webm";

randomPort().then(async (port) => {
  await unlink(path).catch((e) => e);

  const udp = createSocket("udp4");
  udp.bind(port);

  udp.on("message", async (data) => {
    if (Math.random() < 0.2) {
      return;
    }

    udp.send(data, port + 1);
  });

  {
    const args = [
      `videotestsrc`,
      "clockoverlay",
      "video/x-raw,width=640,height=480,format=I420",
      "vp8enc error-resilient=partitions keyframe-max-dist=30 auto-alt-ref=true cpu-used=5 deadline=1",
      "rtpvp8pay",
      `udpsink host=127.0.0.1 port=${port}`,
    ].join(" ! ");
    spawn("gst-launch-1.0", args.split(" "));
  }

  {
    const args = [
      `udpsrc port=${
        port + 1
      } caps = "application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)VP8, payload=(int)96"`,
      "rtpvp8depay",
      "webmmux",
      `filesink location=${path}`,
    ].join(" ! ");

    const process = spawn("gst-launch-1.0", args.split(" "));

    setTimeout(10000).then(() => {
      console.log("stop");
      process.kill("SIGINT");
    });
  }
});
