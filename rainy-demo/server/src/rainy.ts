import { VideoCapture } from "camera-capture";
import { Server } from "ws";
import { RTCPeerConnection } from "../../../src";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });

  const dc = pc.createDataChannel("chat", {});

  dc.stateChanged.subscribe(async (v) => {
    if (v === "open") {
      console.log("dc opened");
      const c = new VideoCapture({ port: 8082, mime: "image/webp", fps: 30 });
      let cache: any;
      c.addFrameListener((frame) => {
        cache = frame.data;
      });
      setInterval(() => {
        if (cache) {
          dc.send(Buffer.from(cache));
        }
      }, 1000 / 20);
      await c.start();
    }
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.send(JSON.stringify(pc.localDescription));

  const answer = JSON.parse(
    await new Promise((r) => socket.on("message", (data) => r(data as string)))
  );

  await pc.setRemoteDescription(answer);
});
