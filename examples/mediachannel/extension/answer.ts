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
    const simulcast = {
      high: pc.addTransceiver("video", "sendonly"),
      middle: pc.addTransceiver("video", "sendonly"),
      low: pc.addTransceiver("video", "sendonly"),
    };

    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v)
    );
    receiver.onTrack.subscribe((track) => {
      track.onRtp.subscribe((rtp) => {
        const sender = simulcast[track.rid];
        sender.sendRtp(rtp.serialize());
      });
    });

    await pc.setRemoteDescription(offer);
    const answer = pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.send(JSON.stringify(answer));
  });
});
