import { spawn } from "child_process";
import { RTCPeerConnection } from "werift";
import { Server } from "ws";
import { randomPort } from "werift/lib/ice/src/utils";
import { createSocket } from "dgram";

const server = new Server({ port: 8888 });
console.log("start");

(async () => {
  server.on("connection", async (socket) => {
    console.log("new peer");
    const pc = new RTCPeerConnection();

    const port = await randomPort();

    const args = [
      `udpsrc port=${port} caps = "application/x-rtp, media=(string)video, clock-rate=(int)90000, encoding-name=(string)VP8, payload=(int)97"`,
      "rtpvp8depay",
      "webmmux",
      `filesink location=./${Math.random().toString().slice(2)}.webm`,
    ].join(" ! ");
    console.log(args);

    const process = spawn("gst-launch-1.0", args.split(" "));
    process.on("message", (data) => console.log("msg", data.toString()));

    const udp = createSocket("udp4");

    pc.ontrack = ({ track }) => {
      track.onReceiveRtp.subscribe(async (rtp) => {
        udp.send(rtp.serialize(), port);
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
