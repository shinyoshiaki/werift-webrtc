import { Server } from "ws";
import {
  RTCPeerConnection,
  useAbsSendTime,
  useSdesMid,
} from "../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesMid(), useAbsSendTime()],
    },
  });
  pc.onconnectionstatechange = () => {
    console.log("connection state", pc.connectionState);
  };
  pc.oniceconnectionstatechange = () => {
    console.log("ice connection state", pc.iceConnectionState);
  };

  const video = pc.addTransceiver("video");
  video.onTrack.subscribe((track) => {
    video.sender.replaceTrack(track);
    // PLI and FIR (RFC 5104) are separate events, but both just mean "send a key frame"
    const requestKeyFrame = () => video.receiver.sendRtcpPLI(track.ssrc);
    video.sender.onPictureLossIndication.subscribe(requestKeyFrame);
    video.sender.onFullIntraRequest.subscribe(requestKeyFrame);
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
