import { RTCPeerConnection } from "../../src";
import { Server } from "ws";
import { createSocket } from "dgram";

const server = new Server({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as string);
    console.log(offer);

    const pc = new RTCPeerConnection({
      stunServer: ["stun.l.google.com", 19302],
    });
    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v)
    );
    let initialPort = 4002;
    pc.onTrack.subscribe((transceiver) => {
      const port = initialPort++;
      transceiver.receiver.onRtp.subscribe((packet) => {
        udp.send(packet.serialize(), port, "127.0.0.1");
      });
    });

    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer()!;
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));
  });
});
