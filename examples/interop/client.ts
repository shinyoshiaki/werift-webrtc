import { RTCPeerConnection } from "../../packages/webrtc/src";
import * as yargs from "yargs";
import axios from "axios";
import { createSocket } from "dgram";
import { RtpPacket } from "../../packages/rtp/src";

// gst-launch-1.0 videotestsrc ! video/x-raw,width=640,height=480,format=I420 ! vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1 ! rtpvp8pay ! udpsink host=127.0.0.1 port=5000
// gst-launch-1.0 -v udpsrc port=4002 caps = "application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)VP8, payload=(int)97" ! rtpvp8depay ! decodebin ! videoconvert ! autovideosink

const args = yargs.option("url", { default: "http://localhost:8080" }).help()
  .argv;

console.log(args);

const udp = createSocket("udp4");
udp.bind(5000);

(async () => {
  const pc = new RTCPeerConnection({
    iceConfig: { stunServer: ["stun.l.google.com", 19302] },
  });
  pc.connectionStateChange.subscribe((state) =>
    console.log("connectionStateChange", state)
  );

  const transceiver = pc.addTransceiver("video", "sendrecv");
  transceiver.onTrack.once((track) => {
    track.onRtp.subscribe((rtp) => {
      console.log(rtp.header);
      udp.send(rtp.serialize(), 4002, "127.0.0.1");
    });
  });

  await pc.setLocalDescription(await pc.createOffer());
  const { data } = await axios.post(args.url + "/offer", pc.localDescription);
  pc.setRemoteDescription(data);

  await pc.connectionStateChange.watch((state) => state === "connected");
  udp.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    rtp.header.payloadType = transceiver.codecs[0].payloadType;
    transceiver.sendRtp(rtp);
  });
})();
