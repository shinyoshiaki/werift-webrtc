import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAbsSendTime,
  useSdesRTPStreamID,
  useTransportWideCC,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    iceConfig: { stunServer: ["stun.l.google.com", 19302] },
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [
            { type: "ccm", parameter: "fir" },
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "goog-remb" },
            { type: "transport-cc" },
          ],
        }),
      ],
    },
    headerExtensions: {
      video: [useSdesRTPStreamID(), useAbsSendTime(), useTransportWideCC()],
    },
  });
  const transceiver = pc.addTransceiver("video", "recvonly", {
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });
  const multiCast = {
    high: pc.addTransceiver("video", "sendonly"),
    low: pc.addTransceiver("video", "sendonly"),
  };
  transceiver.onTrack.subscribe((track) => {
    track.onRtp.subscribe((rtp) => {
      const sender = multiCast[track.rid as keyof typeof multiCast];
      sender.sendRtp(rtp);
    });
  });

  await pc.setLocalDescription(pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
