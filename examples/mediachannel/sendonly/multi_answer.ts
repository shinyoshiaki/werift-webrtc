import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { createSocket } from "dgram";
import { RTCRtpCodecParameters } from "../../../src/rtc/media/parameters";
import { Direction } from "../../../src/rtc/media/rtpTransceiver";

const server = new Server({ port: 8888 });
console.log("start");
const udp1 = createSocket("udp4");
udp1.bind(5000);
const udp2 = createSocket("udp4");
udp2.bind(5001);

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as string);
    console.log(offer);

    const pc = new RTCPeerConnection({
      stunServer: ["stun.l.google.com", 19302],
      codecs: {
        audio: [],
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/VP8",
            clockRate: 90000,
            payloadType: 96,
          }),
        ],
      },
    });
    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v)
    );
    const transceiver1 = pc.addTransceiver("video", "sendonly");
    const transceiver2 = pc.addTransceiver("video", "sendonly");

    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));

    await transceiver1.sender.onReady.asPromise();
    udp1.on("message", (data) => {
      transceiver1.sender.sendRtp(data);
    });
    udp2.on("message", (data) => {
      transceiver2.sender.sendRtp(data);
    });
  });
});
