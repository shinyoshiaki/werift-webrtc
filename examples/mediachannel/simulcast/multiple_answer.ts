import { Server } from "ws";
import {
  RTCPeerConnection,
  useSdesRTPStreamId,
} from "../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as any);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      headerExtensions: {
        video: [useSdesRTPStreamId()],
        audio: [],
      },
    });
    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v),
    );

    {
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      transceiver.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe((rtp) => {
          console.log("track.onReceiveRtp A");
        });
      });
    }
    {
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      transceiver.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe((rtp) => {
          console.log("track.onReceiveRtp B");
        });
      });
    }

    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.send(JSON.stringify(pc.localDescription));
  });
});
