import { Server } from "ws";
import { RTCPeerConnection } from "../../../packages/webrtc/src";
import {
  createRtpRtcpRegister,
  installPolyfill,
} from "../../../packages/webrtc/src/polyfill";

installPolyfill({
  mediaRegister: [
    createRtpRtcpRegister({
      mimeType: "video/VP8",
      udp: { port: 5000 },
      payloadType: 96,
      deviceId: "video-1",
    }),
    createRtpRtcpRegister({
      mimeType: "video/VP8",
      udp: { port: 5001 },
      payloadType: 96,
      deviceId: "video-2",
    }),
  ],
});

const server = new Server({ port: 8888 });
console.log("start");

void (async () => {
  const stream1 = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: "video-1" } },
  });
  const stream2 = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: "video-2" } },
  });
  const source1 = stream1.getVideoTracks()[0];
  const source2 = stream2.getVideoTracks()[0];

  server.on("connection", async (socket) => {
    const pc = new RTCPeerConnection();
    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v),
    );

    if (source1) {
      pc.addTransceiver(source1.clone(), { direction: "sendonly" });
    }
    if (source2) {
      pc.addTransceiver(source2.clone(), { direction: "sendonly" });
    }

    await pc.setLocalDescription(await pc.createOffer());
    const sdp = JSON.stringify(pc.localDescription);
    socket.send(sdp);

    socket.on("message", (data: any) => {
      pc.setRemoteDescription(JSON.parse(data));
    });
  });
})();
