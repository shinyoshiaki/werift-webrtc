import { spawn } from "child_process";
import { createSocket } from "dgram";
import { Server } from "ws";
import { RTCPeerConnection, randomPort } from "../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");

(async () => {
  server.on("connection", async (socket) => {
    console.log("new peer");
    const pc = new RTCPeerConnection();

    const port = await randomPort();

    const args = [
      `udpsrc port=${port} caps="application/x-rtp,media=(string)video,clock-rate=(int)90000,encoding-name=(string)VP8"`,
      "rtpvp8depay",
      "webmmux",
      `filesink location=./${Math.random().toString().slice(2)}.webm`,
    ].join(" ! ");
    console.log(args);

    const gst = spawn(`gst-launch-1.0 -e ${args}`, { shell: true });
    gst.on("error", (error) => console.log("gst error", error));

    const udp = createSocket("udp4");

    pc.ontrack = ({ track }) => {
      track.onReceiveRtp.subscribe(async (rtp) => {
        udp.send(rtp.serialize(), port, "127.0.0.1");
      });
    };
    pc.addTransceiver("video", { direction: "recvonly" });

    const sdp = await pc.setLocalDescription(await pc.createOffer());
    socket.send(JSON.stringify(sdp));

    socket.on("message", (data: any) => {
      const obj = JSON.parse(data);
      if (obj.sdp) pc.setRemoteDescription(obj);
    });
  });
})();
