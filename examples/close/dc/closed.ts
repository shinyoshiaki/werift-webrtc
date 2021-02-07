import { RTCPeerConnection } from "../../../packages/webrtc/src";
import WS, { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as string);
    console.log(offer);

    const pc = new RTCPeerConnection({});
    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer()!;
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));

    pc.onDataChannel.subscribe((channel) => {
      let index = 0;
      channel.message.subscribe((data) => {
        console.log("answer message", data.toString());
      });
      setInterval(() => {
        channel.send(Buffer.from("pong" + index++));
      }, 1000);
      channel.stateChanged.subscribe((v) => console.log("dc.state", v));
    });

    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("iceConnectionStateChange", v)
    );
  });
});
