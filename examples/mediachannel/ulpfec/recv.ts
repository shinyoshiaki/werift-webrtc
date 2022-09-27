import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  Red,
  Vp8RtpPayload,
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
            { type: "goog-remb" },
            { type: "transport-cc" },
            { type: "ccm", parameter: "fir" },
            { type: "nack" },
            { type: "nack", parameter: "pli" },
          ],
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/red",
          clockRate: 90000,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/ulpfec",
          clockRate: 90000,
        }),
      ],
    },
  });

  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
  transceiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.once((rtp) => {
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
      }, 2000);
    });
    track.onReceiveRtp.subscribe((packet) => {
      const red = Red.deSerialize(packet.payload);
      const vp81 = Vp8RtpPayload.deSerialize(red.blocks[0].block);
      const vp82 = Vp8RtpPayload.deSerialize(packet.payload);
      console.log(red);
    });
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
    console.log(pc.remoteDescription.sdp);
  });
});
