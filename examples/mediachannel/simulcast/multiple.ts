import { Server } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useNACK,
  usePLI,
  useREMB,
  useRepairedRtpStreamId,
  useSdesRTPStreamId,
} from "../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesRTPStreamId(), useRepairedRtpStreamId()],
      audio: [],
    },
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          rtcpFeedback: [useNACK(), usePLI(), useREMB()],
        }),
      ],
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v),
  );

  const transceiverA = pc.addTransceiver("video", {
    direction: "recvonly",
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });

  transceiverA.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      console.log("trackA.onReceiveRtp");
    });
  });

  const transceiverB = pc.addTransceiver("video", {
    direction: "recvonly",
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });

  transceiverB.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      console.log("trackB.onReceiveRtp");
    });
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
