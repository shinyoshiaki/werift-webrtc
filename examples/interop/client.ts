import { RTCPeerConnection } from "../../packages/webrtc/src";
import * as yargs from "yargs";
import axios from "axios";
import { createSocket } from "dgram";
import { RtpPacket } from "../../packages/rtp/src";

// ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=30 -vcodec libvpx -keyint_min 30 -cpu-used 5 -deadline 1 -g 10 -error-resilient 1 -auto-alt-ref 1 -f rtp rtp://127.0.0.1:5000
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
      udp.send(rtp.serialize(), 4002, "127.0.0.1");
    });
  });

  await pc.setLocalDescription(pc.createOffer());
  const { data } = await axios.post(args.url + "/offer", pc.localDescription);
  pc.setRemoteDescription(data);

  await pc.connectionStateChange.watch((state) => state === "connected");
  udp.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    rtp.header.payloadType = pc.configuration.codecs.video[0].payloadType;
    transceiver.sendRtp(rtp);
  });
})();
