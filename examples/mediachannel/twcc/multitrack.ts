import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAbsSendTime,
  useTransportWideCC,
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
            { type: "transport-cc" },
          ],
        }),
      ],
    },
    headerExtensions: { video: [useAbsSendTime(), useTransportWideCC()] },
  });
  const senders = [...Array(2)].map(() =>
    pc.addTransceiver("video", "sendonly")
  );
  senders.map((sender) => {
    const receiver = pc.addTransceiver("video", "recvonly");
    receiver.onTrack.once((track) => {
      track.onRtp.subscribe(sender.sendRtp);
      track.onRtp.once(({ header }) => {
        setInterval(() => {
          receiver.receiver.sendRtcpPLI(header.ssrc);
        }, 3000);
      });
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
