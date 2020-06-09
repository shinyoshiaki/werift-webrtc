import { RTCPeerConnection } from "../src";
import WS, { Server } from "ws";

const server = new Server({ port: 8888 });

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as string);

    const pc = new RTCPeerConnection({});
    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer()!;
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));

    pc.datachannel.subscribe((channel) => {
      channel.message.subscribe((data) => {
        console.log("answer message", data.toString());
        setInterval(() => channel.send(Buffer.from("pong")), 1000);
      });
    });
  });
});

const client = async () => {
  const ws = new WS("ws://localhost:8888");

  await new Promise((r) => ws.on("open", r));

  const pc = new RTCPeerConnection({});
  const dc = pc.createDataChannel("chat", { protocol: "bob" });
  const offer = pc.createOffer()!;
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify(pc.localDescription));

  const answer = JSON.parse(
    await new Promise((r) => ws.on("message", (data) => r(data as string)))
  );
  await pc.setRemoteDescription(answer);
  dc.state.subscribe((v) => {
    if (v === "open") {
      console.log("offer open");
      dc.send(Buffer.from("ping"));
    }
  });
  dc.message.subscribe((data) => {
    console.log("offer message", data.toString());
  });
};

// client()
