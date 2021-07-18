import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAbsSendTime,
  useRepairedRtpStreamId,
  useSdesMid,
  useSdesRTPStreamId,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
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
          ],
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
        }),
      ],
    },
    headerExtensions: {
      video: [
        useSdesRTPStreamId(),
        useRepairedRtpStreamId(),
        useAbsSendTime(),
        useSdesMid(),
      ],
    },
  });

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
  socket.send(JSON.stringify(pc.localDescription));

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
