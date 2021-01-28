import {
  RTCPeerConnection,
  useAbsSendTime,
  useSdesMid,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { useTransportWideCC } from "../../../packages/webrtc/src/extension/rtpExtension";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesMid(1), useAbsSendTime(2), useTransportWideCC(3)],
    },
  });
  const transceiver = pc.addTransceiver("video", "sendrecv");

  await pc.setLocalDescription(pc.createOffer());
  socket.send(JSON.stringify(pc.localDescription));

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });

  transceiver.onTrack.subscribe(async (track) => {
    const [rtp] = await track.onRtp.asPromise();
    setInterval(() => {
      transceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
    }, 4000);
    track.onRtp.subscribe(transceiver.sendRtp);
  });
});
