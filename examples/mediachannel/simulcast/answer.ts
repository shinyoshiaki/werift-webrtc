import {
  RTCPeerConnection,
  useSdesRTPStreamID,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as string);

    const pc = new RTCPeerConnection({
      iceConfig: { stunServer: ["stun.l.google.com", 19302] },
      headerExtensions: {
        video: [useSdesRTPStreamID()],
        audio: [],
      },
    });
    const transceiver = pc.addTransceiver("video", "recvonly");
    const multiCast = {
      high: pc.addTransceiver("video", "sendonly"),
      middle: pc.addTransceiver("video", "sendonly"),
      low: pc.addTransceiver("video", "sendonly"),
    };

    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v)
    );
    transceiver.onTrack.subscribe((track) => {
      const sender = multiCast[track.rid as keyof typeof multiCast];
      sender.sender.replaceTrack(track);
    });

    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.send(JSON.stringify(pc.localDescription));
  });
});
