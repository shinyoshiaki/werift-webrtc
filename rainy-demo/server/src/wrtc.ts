import { VideoCapture } from "camera-capture";
import { Server } from "ws";
const { RTCPeerConnection } = require("wrtc");

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const peer = new RTCPeerConnection({});
  peer.onicecandidate = (ev: any) => {
    if (!ev.candidate) {
      socket.send(JSON.stringify(peer.localDescription));
    }
  };
  const channel = peer.createDataChannel("chat");
  channel.onopen = async () => {
    const c = new VideoCapture({ port: 8082, mime: "image/webp", fps: 15 });
    let cache: any;
    c.addFrameListener((frame) => {
      cache = frame.data;
    });
    setInterval(() => {
      console.log(cache);
      if (cache) channel.send(Buffer.from(cache));
    }, 1000 / 30);
    await c.start();
  };

  await new Promise((r) => (peer.onnegotiationneeded = r));

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);

  const answer = JSON.parse(
    await new Promise((r) => socket.on("message", (data) => r(data as string)))
  );

  await peer.setRemoteDescription(answer);
});
