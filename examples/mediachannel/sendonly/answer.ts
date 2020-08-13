import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { createSocket } from "dgram";
import { RTCRtpCodecParameters } from "../../../src/rtc/media/parameters";
import { Direction } from "../../../src/rtc/media/rtpTransceiver";

const server = new Server({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");
udp.bind(5000);

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
    const transceiver = pc.addTransceiver("video", "sendonly");

    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));

    await transceiver.sender.onReady.asPromise();
    udp.on("message", (data) => {
      transceiver.sendRtp(data);
    });
  });
});
