import express from "express";
import { RTCPeerConnection } from "werift";
import * as yargs from "yargs";
import https from "https";
import { readFileSync } from "fs";
import axios from "axios";
import { createSocket } from "dgram";

const args = yargs
  .option("host", {
    description: "Host for HTTP server (default: 0.0.0.0)",
    default: "0.0.0.0",
  })
  .option("port", {
    description: "Port for HTTP server (default: 8080)",
    default: 8080,
  })
  .option("cert-file", { description: "SSL certificate file (for HTTPS)" })
  .option("key-file", { description: "SSL key file (for HTTPS)" })
  .option("static", {})
  .help().argv;

const udp = createSocket("udp4");
udp.bind(5000);

const app = express();
app.use(express.json());
if (args["cert-file"] && args["key-file"]) {
  https
    .createServer(
      {
        cert: readFileSync(args["cert-file"] as string),
        key: readFileSync(args["key-file"] as string),
      },
      app
    )
    .listen(args.port, args.host);
} else {
  app.listen(args.port, args.host);
}
app.use(express.static((args.static as string) || "../html"));

console.log(args);

app.post("/offer", async (req, res) => {
  const offer = req.body;

  const receiver = new RTCPeerConnection({
    iceConfig: { stunServer: ["stun.l.google.com", 19302] },
  });
  const sender = new RTCPeerConnection({
    iceConfig: { stunServer: ["stun.l.google.com", 19302] },
  });
  const senderTransceiver = sender.addTransceiver("video", "sendrecv");
  senderTransceiver.onTrack.once((track) => {
    track.onRtp.subscribe((rtp) => {
      console.log("receive", rtp.header);
      udp.send(rtp.serialize(), 4002, "127.0.0.1");
    });
  });

  receiver.onTransceiver.subscribe(async (transceiver) => {
    const [track] = await transceiver.onTrack.asPromise();
    track.onRtp.subscribe((rtp) => {
      transceiver.sendRtp(rtp);
    });

    senderTransceiver.sender.onReady.once(() => {
      track.onRtp.subscribe((rtp) => {
        rtp.header.payloadType = sender.configuration.codecs.video![0].payloadType!;
        senderTransceiver.sendRtp(rtp);
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
    "http://localhost:8081" + "/offer",
    sender.localDescription
  );
  sender.setRemoteDescription(data);

  await senderTransceiver.sender.onReady.asPromise();
});
