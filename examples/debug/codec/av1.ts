import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  AV1RtpPayload,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

(async () => {
  server.on("connection", async (socket) => {
    console.log("new peer");
    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/AV1X",
            clockRate: 90000,
            rtcpFeedback: [
              { type: "ccm", parameter: "fir" },
              { type: "nack" },
              { type: "nack", parameter: "pli" },
              { type: "goog-remb" },
            ],
          }),
        ],
      },
    });

    pc.ontrack = ({ track, transceiver }) => {
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 3000);

      track.onReceiveRtp.subscribe(async (rtp) => {
        const codec = AV1RtpPayload.deSerialize(rtp.payload);
        if (codec.isKeyframe) {
          console.log("on keyframe", codec);
        }
      });
    };
    pc.addTransceiver("video", { direction: "recvonly" });

    const sdp = await pc.setLocalDescription(await pc.createOffer());
    socket.send(JSON.stringify(sdp));

    socket.on("message", (data: any) => {
      const obj = JSON.parse(data);
      if (obj.sdp) pc.setRemoteDescription(obj);
    });
  });
})();
