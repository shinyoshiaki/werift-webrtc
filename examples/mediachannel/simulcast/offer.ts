import {
  RTCPeerConnection,
  useSdesRTPStreamID,
  useRepairedRtpStreamId,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesRTPStreamID(), useRepairedRtpStreamId()],
      audio: [],
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );

  const transceiver = pc.addTransceiver("video", {
    direction: "recvonly",
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "middle", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });
  const multiCast = {
    high: pc.addTransceiver("video", { direction: "sendonly" }),
    middle: pc.addTransceiver("video", { direction: "sendonly" }),
    low: pc.addTransceiver("video", { direction: "sendonly" }),
  };
  transceiver.onTrack.subscribe((track) => {
    const sender = multiCast[track.rid as keyof typeof multiCast];
    sender.sender.replaceTrack(track);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
