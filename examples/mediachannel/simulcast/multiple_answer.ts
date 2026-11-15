import { WebSocketServer } from "ws";
import {
  RTCPeerConnection,
  useSdesRTPStreamId,
} from "../../../packages/webrtc/src";

const server = new WebSocketServer({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as any);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      headerExtensions: {
        video: [useSdesRTPStreamId()],
        audio: [],
      },
    });
    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v),
    );

    // Each m-line of the browser's offer gets its own (recvonly) transceiver
    // (JSEP 5.10; transceivers added with addTransceiver() before
    // setRemoteDescription() are not paired with it).
    const labels = ["A", "B"];
    pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
      const label = labels.shift();
      transceiver.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe((rtp) => {
          console.log(`track.onReceiveRtp ${label}`);
        });
      });
    });

    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.send(JSON.stringify(pc.localDescription));
  });
});
