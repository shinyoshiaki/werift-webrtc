import { spawn } from "child_process";
import { createSocket } from "dgram";

import { randomPort, RtpPacket, Vp8RtpPayload } from "../../src";

randomPort().then((port) => {
  const udp = createSocket("udp4");
  udp.bind(port);

  const args = [
    `videotestsrc`,
    "video/x-raw,width=640,height=480,format=I420",
    "vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1",
    "rtpvp8pay",
    `udpsink host=127.0.0.1 port=${port}`,
  ].join(" ! ");

  spawn("gst-launch-1.0", args.split(" "));
  udp.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    const vp8 = Vp8RtpPayload.deSerialize(rtp.payload);
    vp8;
  });
});
