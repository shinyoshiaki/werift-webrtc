import { RTCPeerConnection, Vp8RtpPayload } from "../../../packages/webrtc/src";
import { Server } from "ws";
import { writeFileSync } from "fs";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  let index = 0;
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
  transceiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((packet) => {
      const vp8 = Vp8RtpPayload.deSerialize(packet.payload);
      console.log(vp8.isKeyframe);
      if (index > 0 && vp8.isKeyframe) {
        process.exit();
      }
      writeFileSync(`${__dirname}/dump_${index++}.rtp`, packet.serialize());
    });
    track.onReceiveRtp.once(() => {
      setTimeout(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 1000);
    });
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
