import { createSocket } from "dgram";
import axios from "axios";
import cors from "cors";
import express from "express";
import * as yargs from "yargs";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  uint16Add,
} from "../../packages/webrtc/src";

const udp = createSocket("udp4");
udp.bind(5000);

(async () => {
  const args = await yargs
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
      // Probe padding shares the media RTP sequence space. Skipping it without
      // compacting seq looks like loss to the next jitterbuffer.
      let skippedPadding = 0;
      track.onReceiveRtp.subscribe((rtp, _extensions, info) => {
        // GCC probe padding is padding-only RTP; do not forward hop-local probes.
        if (info?.type === "padding") {
          skippedPadding = uint16Add(skippedPadding, 1);
          return;
        }
        const forwarded = rtp.clone();
        forwarded.header.sequenceNumber = uint16Add(
          forwarded.header.sequenceNumber,
          -skippedPadding,
        );
        console.log("receive", forwarded.header);
        udp.send(forwarded.serialize(), 4002, "127.0.0.1");
      });
    });

    receiver.onRemoteTransceiverAdded.subscribe(async (transceiver) => {
      const [track] = await transceiver.onTrack.asPromise();
      transceiver.sender.replaceTrack(track);

      sender.connectionStateChange
        .watch((state) => state === "connected")
        .then(() => {
          // Probe padding shares the media RTP sequence space. Skipping it
          // without compacting seq looks like media loss on the next hop.
          let skippedPadding = 0;
          track.onReceiveRtp.subscribe((rtp, _extensions, info) => {
            // GCC probe padding is padding-only RTP; do not relay hop-local probes.
            if (info?.type === "padding") {
              skippedPadding = uint16Add(skippedPadding, 1);
              return;
            }
            const forwarded = rtp.clone();
            forwarded.header.sequenceNumber = uint16Add(
              forwarded.header.sequenceNumber,
              -skippedPadding,
            );
            forwarded.header.payloadType =
              senderTransceiver.codecs[0].payloadType;
            senderTrack.writeRtp(forwarded);
          });
        });
    });

    await receiver.setRemoteDescription(offer);
    const answer = await receiver.setLocalDescription(
      await receiver.createAnswer(),
    );
    res.send(answer);

    await sender.setLocalDescription(await sender.createOffer());
    const { data } = await axios.post(
      "http://localhost:8080" + "/offer",
      sender.localDescription,
    );
    sender.setRemoteDescription(data);
  });
})();
