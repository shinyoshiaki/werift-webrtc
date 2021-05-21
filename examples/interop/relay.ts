import express from "express";
import cors from "cors";
import { MediaStreamTrack, RTCPeerConnection } from "../../packages/webrtc/src";
import * as yargs from "yargs";
import axios from "axios";
import { createSocket } from "dgram";

const udp = createSocket("udp4");
udp.bind(5000);

const args = yargs
  .option("host", {
    description: "Host for HTTP server (default: 0.0.0.0)",
    default: "0.0.0.0",
  })
  .option("port", {
    description: "Port for HTTP server (default: 8080)",
    default: 8081,
  })
  .help().argv;

const app = express();
app.use(express.json());
app.use(cors());
app.listen(args.port, args.host);
app.post("/offer", async (req, res) => {
  const offer = req.body;

  const receiver = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const sender = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  const senderTrack = new MediaStreamTrack({ kind: "video" });
  const senderTransceiver = sender.addTransceiver(senderTrack);
  senderTransceiver.onTrack.once((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      console.log("receive", rtp.header);
      udp.send(rtp.serialize(), 4002, "127.0.0.1");
    });
  });

  receiver.onRemoteTransceiver.subscribe(async (transceiver) => {
    const [track] = await transceiver.onTrack.asPromise();
    transceiver.sender.replaceTrack(track);

    sender.connectionStateChange
      .watch((state) => state === "connected")
      .then(() => {
        track.onReceiveRtp.subscribe((rtp) => {
          rtp.header.payloadType = senderTransceiver.codecs[0].payloadType;
          senderTrack.writeRtp(rtp);
        });
      });
  });

  await receiver.setRemoteDescription(offer);
  const answer = await receiver.setLocalDescription(
    await receiver.createAnswer()
  );
  res.send(answer);

  await sender.setLocalDescription(await sender.createOffer());
  const { data } = await axios.post(
    "http://localhost:8080" + "/offer",
    sender.localDescription
  );
  sender.setRemoteDescription(data);
});
