import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { createSocket } from "dgram";
import { Direction } from "../../../src/rtc/media/rtpTransceiver";
import { RTCRtpCodecParameters } from "../../../src/rtc/media/parameters";

const server = new Server({ port: 8888 });
console.log("start");
const udp1 = createSocket("udp4");
udp1.bind(5000);
const udp2 = createSocket("udp4");
udp2.bind(5001);

server.on("connection", async (socket) => {
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
  const transceiver1 = pc.addTransceiver("video", Direction.sendonly);
  const transceiver2 = pc.addTransceiver("video", Direction.sendonly);

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  await transceiver1.sender.onReady.asPromise();
  udp1.on("message", (data) => {
    transceiver1.sender.sendRtp(data);
  });
  transceiver2.sender.dtlsTransport = transceiver1.sender.dtlsTransport;
  udp2.on("message", (data) => {
    transceiver2.sender.sendRtp(data);
  });
});
