import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
} from "../../packages/webrtc/src";
import got from "got";
import * as yargs from "yargs";
import { createSocket } from "dgram";
import { exec } from "child_process";

const TestType = { PeerConnection: 0, DataChannelEcho: 1 };

const args = yargs
  .option("s", {
    default:
      process.argv.length === 3
        ? process.argv[2] || "http://localhost:8080/offer"
        : "http://localhost:8080/offer",
  })
  .option("t", {
    default: TestType.PeerConnection,
  })
  .help().argv;
const url = args["s"];
const testType = args["t"];
console.log(args, { url, testType });

const udp = createSocket("udp4");
udp.bind(5000);

new Promise<void>(async (done, failed) => {
  setTimeout(() => {
    failed();
  }, 60_000);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const senderTrack = new MediaStreamTrack({ kind: "video" });
  const transceiver = pc.addTransceiver(senderTrack);
  transceiver.onTrack.once((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      console.log("Received echoed back rtp", rtp.header);
      if (testType === TestType.PeerConnection) {
        done();
      }
    });
  });

  if (testType === TestType.DataChannelEcho) {
    const pseudo = Math.random().toString().slice(2, 7);
    const dc = pc.createDataChannel("werift-dc");
    dc.onopen = () => {
      dc.send(pseudo);
    };
    dc.message.subscribe((msg) => {
      console.log("data channel onmessage");
      if (msg === pseudo) {
        console.log("Data channel echo test success.");
        if (testType === TestType.DataChannelEcho) {
          done();
        }
      }
    });
  }

  await pc.setLocalDescription(await pc.createOffer());
  console.log("local offer ", pc.localDescription?.sdp);
  const data = await got
    .post(url, {
      json: pc.localDescription,
      retry: { limit: 5, methods: ["POST"] },
    })
    .json<any>()
    .catch(failed);
  console.log("server answer sdp", data?.sdp);
  pc.setRemoteDescription(data);

  await pc.connectionStateChange.watch((state) => state === "connected");

  if (testType === TestType.PeerConnection) {
    if (transceiver.receiver.tracks.length === 0) {
      console.log("remoteTrack not found");
      done();
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

    // exec(
    //   "gst-launch-1.0 videotestsrc ! video/x-raw,width=640,height=480,format=I420 ! vp8enc error-resilient=partitions keyframe-max-dist=10 auto-alt-ref=true cpu-used=5 deadline=1 ! rtpvp8pay ! udpsink host=127.0.0.1 port=5000"
    // );
  }
})
  .then(() => {
    // console.log("done");
    // process.exit(0);
  })
  .catch((e) => {
    console.log("failed", e);
    process.exit(1);
  });
