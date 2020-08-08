import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { RTCRtpCodecParameters } from "../../../src/rtc/media/parameters";
import { Direction } from "../../../src/rtc/media/rtpTransceiver";

const server = new Server({ port: 8888 });
console.log("start");

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

    const transceiver1 = pc.addTransceiver("video", Direction.sendrecv);
    const transceiver2 = pc.addTransceiver(
      "video",
      Direction.sendrecv,
      transceiver1
    );

    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));

    await transceiver1.sender.onReady.asPromise();
    transceiver1.receiver.onRtp.subscribe((rtp) => {
      transceiver1.sender.sendRtp(rtp.serialize());
    });
    transceiver2.receiver.onRtp.subscribe((rtp) => {
      transceiver2.sender.sendRtp(rtp.serialize());
    });
  });
});
