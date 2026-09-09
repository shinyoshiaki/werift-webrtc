import { readFileSync } from "fs";
import https from "https";
import express from "express";
import * as yargs from "yargs";
import { RTCPeerConnection } from "../../packages/webrtc/src";

(async () => {
  const args = await yargs
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

  console.log(args);

  const app = express();
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json());
  if (args["cert-file"] && args["key-file"]) {
    https
      .createServer(
        {
          cert: readFileSync(args["cert-file"] as string),
          key: readFileSync(args["key-file"] as string),
        },
        app,
      )
      .listen(args.port, args.host);
  } else {
    app.listen(args.port, args.host);
  }
  console.log("start");
  app.use(express.static((args.static as string) || "./index.html"));

  app.post("/offer", async (req, res) => {
    const offer = req.body;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pc.onRemoteTransceiverAdded.subscribe(async (transceiver) => {
      const [track] = await transceiver.onTrack.asPromise();
      pc.addTrack(track);
    });
    pc.onDataChannel.subscribe((dc) => {
      dc.onMessage.subscribe((msg) => dc.send(msg));
    });

    await pc.setRemoteDescription(offer);
    const answer = await pc.setLocalDescription(await pc.createAnswer());
    res.send(answer);
  });
})();
