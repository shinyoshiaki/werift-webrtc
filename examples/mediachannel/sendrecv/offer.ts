import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import {
  useAbsSendTime,
  useSdesMid,
  // useTransportWideCC,
} from "../../../src/rtc/extension/rtpExtension";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [
        useSdesMid(1),
        useAbsSendTime(2),
        // useTransportWideCC(3)
      ],
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  const transceiver = pc.addTransceiver("video", "sendrecv");

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  transceiver.onTrack.subscribe((track) =>
    track.onRtp.subscribe(transceiver.sendRtp)
  );
});
