import { Server } from "ws";
import {
  RTCPeerConnection,
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
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v),
  );

  // Configure a single video transceiver for sending simulcast
  const sendTransceiver = pc.addTransceiver("video", {
    direction: "sendonly", // Set to sendonly as this peer is offering to send
    simulcast: [
      { rid: "high", direction: "send" }, // Configure high-quality stream
      { rid: "middle", direction: "send" }, // Configure medium-quality stream
      { rid: "low", direction: "send" }, // Configure low-quality stream
    ],
  });

  // Note: In a real application, you would attach a MediaStreamTrack to sendTransceiver.sender
  // For example:
  // const videoTrack = new MediaStreamTrack({ kind: "video" }); // Create or get a track
  // sendTransceiver.sender.replaceTrack(videoTrack);
  // For this example, we focus on the SDP generation based on transceiver configuration.
  // The offer will reflect the intent to send simulcast streams.

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
