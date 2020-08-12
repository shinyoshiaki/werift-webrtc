import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { createSocket } from "dgram";
import { Direction } from "../../../src/rtc/media/rtpTransceiver";

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
    const transceiver = pc.addTransceiver("video", "sendrecv");

    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));

    await transceiver.sender.onReady.asPromise();
    transceiver.onRtp.subscribe((rtp) => {
      udp.send(rtp.serialize(), 4002, "127.0.0.1");
      transceiver.sendRtp(rtp.serialize());
    });
  });
});
