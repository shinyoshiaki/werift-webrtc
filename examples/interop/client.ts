import { RTCPeerConnection, RtpPacket } from "../../packages/webrtc/src";
import axios from "axios";
import { createSocket } from "dgram";
import { exec } from "child_process";
import { MediaStreamTrack } from "werift/src";

const url = process.argv[2] || "http://localhost:8080/offer";

const udp = createSocket("udp4");
udp.bind(5000);

(async () => {
  const pc = new RTCPeerConnection({
    iceConfig: { stunServer: ["stun.l.google.com", 19302] },
  });

  const track = new MediaStreamTrack({ kind: "video" });
  const transceiver = pc.addTransceiver(track);
  transceiver.onTrack.once((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      console.log(rtp.header);
      udp.send(rtp.serialize(), 4002, "127.0.0.1");
    });
  });

  await pc.setLocalDescription(await pc.createOffer());
  const { data } = await axios.post(url, pc.localDescription);
  console.log("server answer sdp", data?.sdp);
  pc.setRemoteDescription(data);

  await pc.connectionStateChange.watch((state) => state === "connected");

  const payloadType = transceiver.codecs.find((codec) =>
    codec.mimeType.toLowerCase().includes("vp8")
  )!.payloadType;

  udp.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    rtp.header.payloadType = payloadType;
    track.writeRtp(rtp);
  });

  exec(
    "gst-launch-1.0 videotestsrc ! video/x-raw,width=640,height=480,format=I420 ! vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1 ! rtpvp8pay ! udpsink host=127.0.0.1 port=5000"
  );
})();
