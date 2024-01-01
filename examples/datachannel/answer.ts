// client side is ./offer.html

import { RTCPeerConnection } from "../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as string);
    console.log(offer);

    const pc = new RTCPeerConnection({});
    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v),
    );
    pc.onDataChannel.subscribe((channel) => {
      let index = 0;
      setInterval(() => {
        channel.send(Buffer.from("ping" + index++));
      }, 1000);

      channel.onMessage.subscribe((data) => {
        console.log("answer message", data.toString());
      });
      channel.stateChanged.subscribe((v) =>
        console.log("channel.stateChanged", v),
      );
    });

    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.send(JSON.stringify(pc.localDescription));
  });
});
