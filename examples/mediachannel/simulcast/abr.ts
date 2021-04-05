import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAbsSendTime,
  useSdesRTPStreamID,
  useTransportWideCC,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { Event } from "rx.mini";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const onMessage = new Event<[any]>();
  socket.on("message", (data: any) => {
    onMessage.execute(data);
  });

  const receiver = new RTCPeerConnection({
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
            { type: "transport-cc" },
          ],
        }),
      ],
    },
    headerExtensions: {
      video: [useAbsSendTime(), useSdesRTPStreamID(), useTransportWideCC()],
    },
  });
  const sender = new RTCPeerConnection({
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
            { type: "transport-cc" },
          ],
        }),
      ],
    },
    headerExtensions: { video: [useAbsSendTime(), useTransportWideCC()] },
  });
  const receiverTransceiver = receiver.addTransceiver("video", {
    direction: "recvonly",
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });

  const senderTransceiver = sender.addTransceiver("video", {
    direction: "sendonly",
  });
  let state = "high";

  receiverTransceiver.onTrack.subscribe(async (track) => {
    if (track.rid === state) {
      senderTransceiver.sender.replaceTrack(track);
    }
    const [rtp] = await track.onReceiveRtp.asPromise();
    setInterval(() => {
      receiverTransceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
    }, 1000);
  });
  const bwe = senderTransceiver.sender.senderBWE;
  bwe.onAvailableBitrate.subscribe((bitrate) => console.log({ bitrate }));
  bwe.onCongestionScore.subscribe((score) => {
    console.log({ score });
    if (score >= 5) {
      if (state != "low") {
        console.log("low");
        state = "low";
        senderTransceiver.sender.replaceTrack(
          receiverTransceiver.receiver.trackByRID["low"]
        );
      }
    } else {
      if (state != "high") {
        console.log("high");
        state = "high";
        senderTransceiver.sender.replaceTrack(
          receiverTransceiver.receiver.trackByRID["high"]
        );
      }
    }
  });
  bwe.onCongestion.subscribe((congestion) => console.log({ congestion }));

  {
    await receiver.setLocalDescription(await receiver.createOffer());
    socket.send(JSON.stringify(receiver.localDescription));
    const [data] = await onMessage.asPromise();
    receiver.setRemoteDescription(JSON.parse(data));
  }

  {
    await sender.setLocalDescription(await sender.createOffer());
    socket.send(JSON.stringify(sender.localDescription));
    const [data] = await onMessage.asPromise();
    sender.setRemoteDescription(JSON.parse(data));
  }
});
