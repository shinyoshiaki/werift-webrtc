import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAbsSendTime,
  useSdesRTPStreamID,
  useTransportWideCC,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { Event } from "rx.mini";
import { RtpHeader } from "../../../packages/rtp/src";

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
          ],
        }),
      ],
    },
    headerExtensions: { video: [useAbsSendTime(), useSdesRTPStreamID()] },
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
  const receiverTransceiver = receiver.addTransceiver("video", "recvonly", {
    simulcast: [
      { rid: "high", direction: "recv" },
      { rid: "low", direction: "recv" },
    ],
  });
  const senderTransceiver = sender.addTransceiver("video", "sendonly");
  let state = "high";

  let low: RtpHeader, high: RtpHeader;
  receiverTransceiver.onTrack.subscribe(async (track) => {
    let ssrc = 0;
    track.onRtp.subscribe((rtp) => {
      ssrc = rtp.header.ssrc;
      switch (track.rid) {
        case "high":
          high = rtp.header;
          break;

        case "low":
          low = rtp.header;
          break;
      }

      if (state === track.rid) {
        senderTransceiver.sendRtp(rtp);
      }
    });
    setInterval(() => {
      if (ssrc) {
        receiverTransceiver.receiver.sendRtcpPLI(ssrc);
      }
    }, 1000);
  });
  const bwe = senderTransceiver.sender.senderBWE;
  bwe.onAvailableBitrate.subscribe((bitrate) => console.log({ bitrate }));
  bwe.onCongestionScore.subscribe((score) => {
    console.log({ score });
    if (5 <= score) {
      if (state != "low") {
        console.log("low");
        state = "low";
        senderTransceiver.replaceRtp(low);
      }
    } else {
      if (state != "high") {
        console.log("high");
        state = "high";
        senderTransceiver.replaceRtp(high);
      }
    }
  });
  bwe.onCongestion.subscribe((congestion) => console.log({ congestion }));

  {
    const offer = receiver.createOffer();
    await receiver.setLocalDescription(offer);
    socket.send(JSON.stringify(receiver.localDescription));
    const [data] = await onMessage.asPromise();
    receiver.setRemoteDescription(JSON.parse(data));
  }

  {
    await sender.setLocalDescription(sender.createOffer());
    socket.send(JSON.stringify(sender.localDescription));
    const [data] = await onMessage.asPromise();
    sender.setRemoteDescription(JSON.parse(data));
  }
});
