import {
  RTCPeerConnection,
  useSdesRTPStreamID,
  RTCRtpTransceiver,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
    headerExtensions: {
      video: [useSdesRTPStreamID()],
      audio: [],
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );

  const transceiver = pc.addTransceiver("video", "recvonly", {
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "middle", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });
  const multiCast = {
    high: pc.addTransceiver("video", "sendonly"),
    middle: pc.addTransceiver("video", "sendonly"),
    low: pc.addTransceiver("video", "sendonly"),
  };
  transceiver.onTrack.subscribe((track) => {
    track.onRtp.subscribe((rtp) => {
      const sender = multiCast[track.rid] as RTCRtpTransceiver;
      sender.sendRtp(rtp);
    });
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
