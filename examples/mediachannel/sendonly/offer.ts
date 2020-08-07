import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { createSocket } from "dgram";
import { DtlsState } from "../../../src/rtc/transport/dtls";
import { Direction } from "../../../src/rtc/media/rtpTransceiver";

const server = new Server({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");
udp.bind(5000);

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  const transceiver = pc.addTransceiver("video", Direction.sendonly);

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  await new Promise((r) => {
    transceiver.dtlsTransport.stateChanged.subscribe((state) => {
      if (state === DtlsState.CONNECTED) {
        r();
      }
    });
  });
  udp.on("message", (data) => {
    transceiver.sender.sendRtp(data);
  });
});
