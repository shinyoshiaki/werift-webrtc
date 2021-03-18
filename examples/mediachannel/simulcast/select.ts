import {
  RTCPeerConnection,
  useSdesRTPStreamID,
  useSdesMid,
  MediaStreamTrack,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    iceConfig: { stunServer: ["stun.l.google.com", 19302] },
    headerExtensions: {
      video: [useSdesMid(), useSdesRTPStreamID()],
    },
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );

  const transceiver = pc.addTransceiver("video", "recvonly", {
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "middle", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });

  let source = "middle";

  let sender = pc.addTransceiver("video", "sendonly");
  transceiver.onTrack.subscribe((track) => {
    track.onRtp.subscribe((rtp) => {
      if (track.rid === source) {
        sender.sender.sendRtp(rtp);
      }
    });

    track.onRtp.once((rtp) => {
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
      }, 1000);
    });
  });

  pc.createDataChannel("dc").message.subscribe(async (msg) => {
    pc.removeTrack(sender);
    sender = pc.addTransceiver("video", "sendonly");
    source = msg.toString();

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
