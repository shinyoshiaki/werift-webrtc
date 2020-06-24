import { RTCPeerConnection } from "../../src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  const dc = pc.createDataChannel("chat", { protocol: "bob" });
  const offer = pc.createOffer()!;
  await pc.setLocalDescription(offer);
  socket.send(JSON.stringify(pc.localDescription));

  const answer = JSON.parse(
    await new Promise((r) => socket.on("message", (data) => r(data as string)))
  );
  console.log(answer);

  await pc.setRemoteDescription(answer);
  dc.state.subscribe((v) => {
    if (v === "open") {
      let index = 0;
      setInterval(() => {
        dc.send(Buffer.from("ping" + index++));
        if (index > 4) pc.close();
      }, 1000);
    }
  });
  dc.message.subscribe((data) => {
    console.log("message", data.toString());
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("iceConnectionStateChange", v)
  );
  dc.state.subscribe((v) => console.log("dc.state", v));
});
