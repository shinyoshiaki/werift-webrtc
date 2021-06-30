import { RTCPeerConnection } from "../../packages/webrtc/src";
import { Server } from "ws";
import child from "child_process";
import { createSocket } from "dgram";

const process = child.spawn(
  `gst-launch-1.0`,
  `udpsrc port=6666 caps="application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)VP8, payload=(int)97" ! rtpvp8depay ! webmmux ! filesink location=../${
    Math.random().toString().split(".")[1]
  }.webm`.split(" ")
);

process.on("SIGINT", () => {
  process.kill("SIGINT");
});

const udp = createSocket("udp4");
const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});

  {
    const transceiver = pc.addTransceiver("video");
    transceiver.onTrack.subscribe((track) => {
      transceiver.sender.replaceTrack(track);
      track.onReceiveRtp.subscribe((rtp) => {
        udp.send(rtp.serialize(), 6666, "127.0.0.1");
      });
      track.onReceiveRtp.once(() => {
        setInterval(() => transceiver.receiver.sendRtcpPLI(track.ssrc), 5000);
      });
    });
  }

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
