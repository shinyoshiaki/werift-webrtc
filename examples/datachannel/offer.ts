// client side is ./answer.html

import { Server } from "ws";
import { RTCPeerConnection } from "../../packages/webrtc/src/index.js";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.oniceconnectionstatechange = () => {
    console.log("oniceconnectionstatechange", pc.iceConnectionState);
  };

  const dc = pc.createDataChannel("chat");
  dc.stateChanged.subscribe((v) => {
    console.log("dc.stateChanged", v);
    if (v === "open") {
      console.log("open");
    }
  });

  let index = 0;
  dc.onMessage.subscribe((data) => {
    console.log("message", data.toString());
    dc.send("pong" + index++);
  });

  await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify(pc.localDescription));

  const answer = JSON.parse(
    await new Promise((r) =>
      socket.on("message", (data) => r(data as unknown as string)),
    ),
  );
  await pc.setRemoteDescription(answer);
});
