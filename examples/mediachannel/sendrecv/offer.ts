import {
  RTCPeerConnection,
  useAbsSendTime,
  useSdesMid,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesMid(), useAbsSendTime()],
    },
  });

  const video = pc.addTransceiver("video");
  video.onTrack.subscribe((track) => {
    video.sender.replaceTrack(track);
  });

  const audio = pc.addTransceiver("audio");
  audio.onTrack.subscribe((track) => {
    audio.sender.replaceTrack(track);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
