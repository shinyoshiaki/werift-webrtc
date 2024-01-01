import {
  RTCPeerConnection,
  useSdesRTPStreamId,
  useSdesMid,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    headerExtensions: {
      video: [useSdesMid(), useSdesRTPStreamId()],
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v),
  );

  const transceiver = pc.addTransceiver("video", {
    direction: "recvonly",
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "middle", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });

  const source = "middle";

  let sender = pc.addTransceiver("video", { direction: "sendonly" });
  transceiver.onTrack.subscribe((track) => {
    if (track.rid === source) {
      console.log("init", source);
      sender.sender.replaceTrack(track);
    }

    track.onReceiveRtp.once((rtp) => {
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
      }, 1000);
    });
  });

  pc.createDataChannel("dc").onMessage.subscribe(async (msg) => {
    pc.removeTrack(sender.sender);
    sender = pc.addTransceiver("video", { direction: "sendonly" });
    const source = msg.toString();
    const track = transceiver.receiver.trackByRID[source];
    if (track) {
      console.log("replace", track);
      sender.sender.replaceTrack(track);
    }

    await pc.setLocalDescription(await pc.createOffer());
    const sdp = JSON.stringify(pc.localDescription);
    socket.send(sdp);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
