import {
  RTCPeerConnection,
  useSdesRTPStreamID,
  useSdesMid,
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
    let ssrc = 0;
    track.onRtp.subscribe((rtp) => {
      ssrc = rtp.header.ssrc;
      if (track.rid === source) {
        sender.sendRtp(rtp);
      }
    });

    setInterval(() => {
      if (ssrc) {
        transceiver.receiver.sendRtcpPLI(ssrc);
      }
    }, 1000);
  });

  pc.createDataChannel("dc").message.subscribe(async (msg) => {
    pc.removeTrack(sender);
    sender = pc.addTransceiver("video", "sendonly");
    source = msg.toString();

    const offer = pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = JSON.stringify(pc.localDescription);
    socket.send(sdp);
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
