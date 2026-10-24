import { Server } from "ws";
import {
  RTCPeerConnection,
  useSdesRTPStreamId,
} from "../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    headerExtensions: {
      video: [useSdesRTPStreamId()],
      audio: [],
    },
  });
  pc.onconnectionstatechange = () => {
    console.log("connection state", pc.connectionState);
  };
  pc.oniceconnectionstatechange = () => {
    console.log("ice connection state", pc.iceConnectionState);
  };

  const transceiver = pc.addTransceiver("video", { direction: "sendrecv" });
  transceiver.onTrack.subscribe((track, transceiver) => {
    transceiver.sender.replaceTrack(track);
    track.onReceiveRtp.once(() => {
      transceiver.receiver.sendRtcpPLI(track.ssrc);
    });
  });

  socket.on("message", async (data) => {
    const msg = JSON.parse(data as unknown as string);
    if (msg.candidate) {
      pc.addIceCandidate(msg);
    } else {
      await pc.setRemoteDescription(msg);
      await pc.setLocalDescription(await pc.createAnswer());
      socket.send(JSON.stringify(pc.localDescription));
    }
  });
});
