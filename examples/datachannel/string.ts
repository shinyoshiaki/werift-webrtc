import { RTCPeerConnection } from "../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );

  const dc = pc.createDataChannel("chat", {
    protocol: "bob",
  });
  dc.stateChanged.subscribe((v) => {
    console.log("dc.stateChanged", v);
    if (v === "open") {
      console.log("open");
    }
  });

  let index = 0;
  dc.message.subscribe((data) => {
    console.log("message", data.toString());
    dc.send("pong" + index++);
  });

  const offer = pc.createOffer()!;
  await pc.setLocalDescription(offer);
  socket.send(JSON.stringify(pc.localDescription));

  const answer = JSON.parse(
    await new Promise((r) => socket.on("message", (data) => r(data as string)))
  );
  console.log(answer);

  await pc.setRemoteDescription(answer);
});
