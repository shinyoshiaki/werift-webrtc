import { VideoCapture } from "camera-capture";
import { Server } from "ws";
import { RTCPeerConnection } from "../../../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
const c = new VideoCapture({ port: 8082, mime: "image/webp", fps: 60 });
c.start();
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  const dc = pc.createDataChannel("chat", {
    ordered: false,
    maxRetransmits: 3,
  });

  dc.stateChanged.subscribe(async (v) => {
    if (v === "open") {
      console.log("dc opened");

      let cache: any;
      c.addFrameListener((frame) => {
        cache = frame.data;
      });
      setInterval(() => {
        if (cache) {
          dc.send(Buffer.from(cache));
        }
      }, 1000 / 60);
    }
  });

  await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify(pc.localDescription));

  socket.on("message", (str) => {
    console.log("message", str);
    const data = JSON.parse(str as string);
    switch (data.type) {
      case "answer":
        pc.setRemoteDescription(data);
        break;
      case "candidate":
        pc.addIceCandidate(data);
        break;
    }
  });
});
