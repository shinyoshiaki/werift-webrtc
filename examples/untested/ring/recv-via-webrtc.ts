import { RingApi } from "ring-client-api";
import { Server } from "ws";
import { MediaStreamTrack, RTCPeerConnection } from "../../../packages/webrtc/src";
import {
  createCallbackRegister,
  installPolyfill,
} from "../../../packages/webrtc/src/polyfill";
import { CustomPeerConnection } from "./peer";

const example = async () => {
  const ringApi = new RingApi({
    // Replace with your refresh token
    refreshToken: process.env.RING_REFRESH_TOKEN!,
    debug: true,
  });
  const cameras = await ringApi.getCameras();
  const camera = cameras[0];

  if (!camera) {
    console.log("No cameras found");
    return;
  }

  const ring = new CustomPeerConnection();
  installPolyfill({
    mediaRegister: [
      createCallbackRegister({
        mimeType: "video/H264",
        kinds: ["video"],
        async createTracks() {
          const track = new MediaStreamTrack({ kind: "video" });
          ring.onVideoRtp.subscribe((rtp) => {
            track.writeRtp(rtp);
          });
          return [track];
        },
      }),
    ],
  });
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  await camera.startLiveCall({
    createPeerConnection: () => ring,
  });
  const server = new Server({ port: 8888 });

  console.log(new Date().toISOString(), "session start");

  server.on("connection", async (socket) => {
    const sender = new RTCPeerConnection();
    if (track) {
      sender.addTransceiver(track, { direction: "sendonly" });
    }

    await sender.setLocalDescription(await sender.createOffer());
    const sdp = JSON.stringify(sender.localDescription);
    socket.send(sdp);

    socket.on("message", async (data: any) => {
      await sender.setRemoteDescription(JSON.parse(data));
    });
  });
};
example().catch((e) => {
  console.error(e);
});
