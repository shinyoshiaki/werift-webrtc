// client side is ./answer.html

import { RTCPeerConnection } from "../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});

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
    dc.send(Buffer.from("pong" + index++));
  });

  await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify(pc.localDescription));

  const answer = JSON.parse(
    await new Promise((r) => socket.on("message", (data) => r(data as string))),
  );
  await pc.setRemoteDescription(answer);
});
