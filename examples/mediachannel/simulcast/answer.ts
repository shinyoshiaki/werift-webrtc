import { WebSocketServer } from "ws";
import {
  RTCPeerConnection,
  type RTCRtpTransceiver,
  useSdesRTPStreamId,
} from "../../../packages/webrtc/src";

const server = new WebSocketServer({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as unknown as string);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      headerExtensions: {
        video: [useSdesRTPStreamId()],
        audio: [],
      },
    });
    // The browser offers a simulcast sendonly m-line and three recvonly
    // ones. Each gets its own transceiver (JSEP 5.10; transceivers added with
    // addTransceiver() before setRemoteDescription() are not paired): receive
    // the layers on the first and send each layer back on one of the others.
    const remote: RTCRtpTransceiver[] = [];
    const multiCast = {
      high: () => remote[1],
      middle: () => remote[2],
      low: () => remote[3],
    };
    pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
      remote.push(transceiver);
      if (remote.length > 1) {
        transceiver.setDirection("sendonly");
        return;
      }
      transceiver.onTrack.subscribe((track) => {
        const sender = multiCast[track.rid as keyof typeof multiCast]?.();
        sender?.sender.replaceTrack(track);
      });
    });

    pc.iceConnectionStateChange.subscribe((v) =>
      console.log("pc.iceConnectionStateChange", v),
    );

    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.send(JSON.stringify(pc.localDescription));
  });
});
