import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
} from "../../packages/webrtc/src";
import axios from "axios";
import { createSocket } from "dgram";
import { exec } from "child_process";
import debug from "debug";

const log = debug("werift/interop");

const url = process.argv[2] || "http://localhost:8080/offer";

const udp = createSocket("udp4");
udp.bind(5000);

new Promise<void>(async (r, f) => {
  setTimeout(() => {
    f();
  }, 60_000);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const senderTrack = new MediaStreamTrack({ kind: "video" });
  const transceiver = pc.addTransceiver(senderTrack);
  transceiver.onTrack.once((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      log(rtp.header);
      log("Received echoed back rtp");
      r();
    });
  });

  await pc.setLocalDescription(await pc.createOffer()).catch((e) => f(e));
  const { data } = await axios.post(url, pc.localDescription).catch((e) => {
    f(e);
    throw e;
  });
  log("server answer sdp", data?.sdp);
  pc.setRemoteDescription(data).catch((e) => f(e));

  await pc.connectionStateChange.watch((state) => state === "connected");
  if (transceiver.receiver.tracks.length === 0) {
    log("remoteTrack not found");
    r();
    return;
  }

  const payloadType = transceiver.codecs.find((codec) =>
    codec.mimeType.toLowerCase().includes("vp8")
  )!.payloadType;

  udp.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    rtp.header.payloadType = payloadType;
    senderTrack.writeRtp(rtp);
  });

  exec(
    "gst-launch-1.0 videotestsrc ! video/x-raw,width=640,height=480,format=I420 ! vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1 ! rtpvp8pay ! udpsink host=127.0.0.1 port=5000"
  );
})
  .then(() => {
    log("done");
    process.exit(0);
  })
  .catch((e) => {
    log("failed", e);
    process.exit(1);
  });
