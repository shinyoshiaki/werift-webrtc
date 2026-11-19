import { WebSocketServer } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpTransceiver,
  useAbsSendTime,
  useRepairedRtpStreamId,
  useSdesMid,
  useSdesRTPStreamId,
} from "../../../../packages/webrtc/src";

const server = new WebSocketServer({ port: 8888 });
console.log("start");

server.on("connection", (socket) => {
  socket.on("message", async (data) => {
    const offer = JSON.parse(data as unknown as string);

    const pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/VP8",
            clockRate: 90000,
            rtcpFeedback: [
              { type: "ccm", parameter: "fir" },
              { type: "nack" },
              { type: "nack", parameter: "pli" },
              { type: "goog-remb" },
            ],
          }),
          new RTCRtpCodecParameters({
            mimeType: "video/rtx",
            clockRate: 90000,
          }),
        ],
      },
      headerExtensions: {
        video: [
          useSdesRTPStreamId(),
          useRepairedRtpStreamId(),
          useAbsSendTime(),
          useSdesMid(),
        ],
      },
    });

    // The browser offers a simulcast sendonly m-line and three recvonly
    // ones; each gets its own transceiver (JSEP 5.10). Receive the layers on
    // the first and send each layer back on one of the others.
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
    // transceiver.receiver.onPacketLost.subscribe((nack) => {
    //   console.log("packet loss", nack.lost);
    // });

    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.send(JSON.stringify(pc.localDescription));
  });
});
