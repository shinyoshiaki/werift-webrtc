import { RTCPeerConnection } from "../../../packages/webrtc/src";
import express from "express";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((_, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  next();
});
app.listen(12223);
console.log("start");

const pc = new RTCPeerConnection({});

const dc = pc.createDataChannel("chat");
dc.stateChanged.subscribe((v) => {
  console.log("dc.stateChanged", v);
  if (v === "open") {
    console.log("open");
  }
});

let index = 0;
dc.message.subscribe((data) => {
  console.log("message", data.toString());
  dc.send(Buffer.from("pong" + index++));
});

app.get("/connection", async (req, res) => {
  await pc.setLocalDescription(await pc.createOffer());
  return res.send({ offer: pc.localDescription });
});

app.post("/answer", async (req, res) => {
  const { answer } = req.body;
  pc.setRemoteDescription(answer);
  return res.send({});
});

app.post("/candidate", async (req, res) => {
  const { candidate } = req.body;
  pc.addIceCandidate(candidate);
  return res.send({});
});
