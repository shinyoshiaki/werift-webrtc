import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { useSdesRTPStreamID } from "../../../src/rtc/extension/rtpExtension";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
    headerExtensions: {
      video: [useSdesRTPStreamID()],
      audio: [],
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

  pc.createDataChannel("dc").message.subscribe(async (v) => {
    source = "";
    console.log("dc", v.toString());
    sender.direction = "inactive";
    sender = pc.addTransceiver("video", "sendonly");
    const offer = pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = JSON.stringify(pc.localDescription);
    socket.send(sdp);
    // await sender.sender.onReady.asPromise();
    source = v.toString();
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    console.log("set remote");
    pc.setRemoteDescription(JSON.parse(data));
  });
});
