import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import {
  useSdesMid,
  useSdesRTPStreamID,
} from "../../../src/rtc/extension/rtpExtension";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as string);
    console.log(offer);

    const pc = new RTCPeerConnection({
      stunServer: ["stun.l.google.com", 19302],
      headerExtensions: {
        video: [useSdesMid(), useSdesRTPStreamID()],
        audio: [],
      },
    });
    pc.addTransceiver("video", "recvonly");
    const f = pc.addTransceiver("video", "sendonly");
    const h = pc.addTransceiver("video", "sendonly");
    const q = pc.addTransceiver("video", "sendonly");

    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v)
    );
    pc.onReceiver.subscribe((receiver) => {
      receiver.onRtp.subscribe((rtp) => {
        const rid = rtp.header.extensions[1].payload.toString();
        switch (rid) {
          case "f":
            f.sendRtp(rtp.serialize());
            break;
          case "h":
            h.sendRtp(rtp.serialize());
            break;
          case "q":
            q.sendRtp(rtp.serialize());
            break;
        }
      });
    });

    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));
  });
});
