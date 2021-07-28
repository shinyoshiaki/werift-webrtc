import { RTCPeerConnection, Vp8RtpPayload } from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

(async () => {
  server.on("connection", async (socket) => {
    console.log("new peer");
    const pc = new RTCPeerConnection();

    pc.ontrack = ({ track, transceiver }) => {
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }, 3000);
      track.onReceiveRtp.subscribe(async (rtp) => {
        const vp8 = Vp8RtpPayload.deSerialize(rtp.payload);

        if (vp8.isKeyframe) {
          console.log("on keyframe", rtp.payload.length);
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
