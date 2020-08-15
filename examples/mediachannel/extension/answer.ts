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
    const receiver = pc.addTransceiver("video", "recvonly").receiver;
    const h = pc.addTransceiver("video", "sendonly");
    const m = pc.addTransceiver("video", "sendonly");
    const l = pc.addTransceiver("video", "sendonly");

    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v)
    );
    receiver.onTrack.subscribe((track) => {
      track.onRtp.subscribe((rtp) => {
        switch (track.rid) {
          case "h":
            h.sendRtp(rtp.serialize());
            break;
          case "m":
            m.sendRtp(rtp.serialize());
            break;
          case "l":
            l.sendRtp(rtp.serialize());
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
